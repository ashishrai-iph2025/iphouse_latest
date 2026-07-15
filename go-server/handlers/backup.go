package handlers

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
)

// Database backup — fully self-contained. The database is dumped over the app's
// own MySQL connection (see backup_dump.go) and streamed straight to S3 with
// the AWS SDK. No mysqldump binary and no aws CLI are required, so this works
// unchanged inside a minimal container with the database hosted elsewhere.
//
// Super-Admin only (registered under saAuth in main.go). AWS credentials come
// from the encrypted aws_credentials table; if none are stored, the SDK's
// default chain (environment / instance IAM role) is used.

type backupCfg struct {
	name                         string
	bucket, prefix               string
	awsKey, awsSecret, awsRegion string
}

func loadBackupCfg() backupCfg {
	c := backupCfg{name: config.C.DBName}

	s3uri := "s3://powerbi-backup-db/database-backup"
	if v := os.Getenv("BACKUP_S3_URI"); v != "" {
		s3uri = v
	}
	if row, _ := db.QueryOne("SELECT access_key_id, secret_access_key, region, s3_uri FROM aws_credentials ORDER BY id DESC LIMIT 1"); row != nil {
		c.awsKey = decryptOrRaw(strFromAny(row["access_key_id"]))
		c.awsSecret = decryptOrRaw(strFromAny(row["secret_access_key"]))
		c.awsRegion = strFromAny(row["region"])
		if u := strFromAny(row["s3_uri"]); u != "" {
			s3uri = u
		}
	}
	c.bucket, c.prefix = parseS3URI(s3uri)
	return c
}

func decryptOrRaw(s string) string {
	if s == "" {
		return ""
	}
	if d := ipauth.DecryptMain(s); d != "" {
		return d
	}
	return s
}

func parseS3URI(uri string) (bucket, prefix string) {
	s := strings.TrimPrefix(strings.TrimSpace(uri), "s3://")
	parts := strings.SplitN(s, "/", 2)
	bucket = parts[0]
	if len(parts) > 1 {
		prefix = strings.Trim(parts[1], "/")
	}
	return
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return "…" + s[len(s)-n:]
	}
	return s
}

// s3ClientFor builds an S3 client from the stored credentials, falling back to
// the SDK default chain (env vars, instance IAM role) when none are stored.
func s3ClientFor(ctx context.Context, cfg backupCfg) (*s3.Client, error) {
	var opts []func(*awsconfig.LoadOptions) error
	if cfg.awsRegion != "" {
		opts = append(opts, awsconfig.WithRegion(cfg.awsRegion))
	}
	if cfg.awsKey != "" && cfg.awsSecret != "" {
		opts = append(opts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.awsKey, cfg.awsSecret, "")))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, opts...)
	if err != nil {
		return nil, err
	}
	if awsCfg.Region == "" {
		return nil, fmt.Errorf("no AWS region configured — set it on the AWS Credentials page")
	}
	return s3.NewFromConfig(awsCfg), nil
}

func (c backupCfg) key(file string) string {
	if c.prefix == "" {
		return file
	}
	return c.prefix + "/" + file
}

// backupMu ensures only one backup runs at a time (manual or scheduled).
var backupMu sync.Mutex

// performBackup dumps the database and uploads it to S3, recording the outcome
// on the schedule row so the page can show last-run status. Shared by the
// manual endpoint and the scheduler.
func performBackup(ctx context.Context, trigger string) (file, dest, dur string, err error) {
	cfg := loadBackupCfg()
	if cfg.bucket == "" {
		return "", "", "", fmt.Errorf("the backup S3 target is not configured")
	}
	client, cerr := s3ClientFor(ctx, cfg)
	if cerr != nil {
		return "", "", "", cerr
	}

	file = fmt.Sprintf("%s_%s.sql", cfg.name, time.Now().Format("2006-01-02_15-04-05"))
	key := cfg.key(file)

	// Stream the dump straight into the S3 uploader via an in-memory pipe — the
	// full dump is never held in memory or written to the container's disk.
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(dumpDatabase(ctx, cfg.name, pw)) }()

	start := time.Now()
	uploader := manager.NewUploader(client)
	_, uerr := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket:      awssdk.String(cfg.bucket),
		Key:         awssdk.String(key),
		Body:        pr,
		ContentType: awssdk.String("application/sql"),
	})
	if uerr != nil {
		pr.CloseWithError(uerr)
		log.Printf("[backup] (%s) FAILED after %s: %v", trigger, time.Since(start).Round(time.Second), uerr)
		recordBackupRun("failed", file, tail(uerr.Error(), 500))
		return file, "", "", uerr
	}

	dur = time.Since(start).Round(time.Second).String()
	dest = fmt.Sprintf("s3://%s/%s", cfg.bucket, key)
	log.Printf("[backup] (%s) uploaded %s in %s", trigger, dest, dur)
	recordBackupRun("success", file, "")
	return file, dest, dur, nil
}

// recordBackupRun stores the outcome of the most recent backup on the schedule
// row (creating it with defaults if it doesn't exist yet).
func recordBackupRun(status, file, errMsg string) {
	db.Exec(`INSERT INTO backup_schedule (id, last_run_at, last_status, last_file, last_error)
		VALUES (1, NOW(), ?, ?, ?)
		ON DUPLICATE KEY UPDATE last_run_at=NOW(), last_status=?, last_file=?, last_error=?`,
		status, file, errMsg, status, file, errMsg)
}

// POST /api/admin/backup/run — dump the database and upload it to S3.
func RunBackup(w http.ResponseWriter, r *http.Request) {
	if !backupMu.TryLock() {
		Fail(w, 409, "A backup is already running. Please wait for it to finish."); return
	}
	defer backupMu.Unlock()

	// Detached from the request so a client/proxy disconnect can't abort an
	// upload mid-stream; the handler still waits for the result.
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()

	file, dest, dur, err := performBackup(ctx, "manual")
	if err != nil {
		Fail(w, 502, "Backup failed: "+tail(err.Error(), 300)); return
	}
	OK(w, map[string]any{
		"success": true, "file": file, "destination": dest,
		"duration": dur, "message": "Backup completed and uploaded to S3.",
	})
}

// GET /api/admin/backup/list — list the backups already stored in S3.
func ListBackups(w http.ResponseWriter, r *http.Request) {
	cfg := loadBackupCfg()
	if cfg.bucket == "" {
		Fail(w, 500, "The backup S3 target is not configured. Set it on the AWS Credentials page."); return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, err := s3ClientFor(ctx, cfg)
	if err != nil {
		Fail(w, 500, "AWS is not configured correctly: "+err.Error()); return
	}

	prefix := cfg.prefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	backups := make([]map[string]any, 0)
	paginator := s3.NewListObjectsV2Paginator(client, &s3.ListObjectsV2Input{
		Bucket: awssdk.String(cfg.bucket),
		Prefix: awssdk.String(prefix),
	})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			log.Printf("[backup] list failed: %v", err)
			Fail(w, 502, "Could not list backups from S3: "+tail(err.Error(), 250)); return
		}
		for _, obj := range page.Contents {
			k := awssdk.ToString(obj.Key)
			name := k
			if i := strings.LastIndex(name, "/"); i >= 0 {
				name = name[i+1:]
			}
			if name == "" {
				continue
			}
			lm := ""
			if obj.LastModified != nil {
				lm = obj.LastModified.UTC().Format(time.RFC3339)
			}
			backups = append(backups, map[string]any{
				"name": name, "key": k, "size": awssdk.ToInt64(obj.Size),
				"lastModified": lm, "storageClass": string(obj.StorageClass),
			})
		}
	}
	sort.Slice(backups, func(i, j int) bool {
		return strFromAny(backups[i]["lastModified"]) > strFromAny(backups[j]["lastModified"])
	})

	OK(w, map[string]any{
		"success": true, "bucket": cfg.bucket, "prefix": cfg.prefix,
		"count": len(backups), "backups": backups,
	})
}
