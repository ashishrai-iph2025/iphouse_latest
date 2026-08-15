package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	awssdk "github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/feature/s3/manager"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/notify"
)

// Data Sharing — client module. A granted user uploads an .xlsx file, which is
// stored in S3 (s3://mediascan-filestore/file_sharing/ by default) using the
// shared AWS credentials from the aws_credentials table. A presigned GET URL,
// valid for 7 days (AWS's hard maximum for SigV4 presigned URLs), is generated
// and recorded in data_sharing_history along with who uploaded it and when.

// presignMaxTTL is AWS's hard cap for SigV4 presigned URLs (7 days).
const presignMaxTTL = 7 * 24 * time.Hour

// maxUploadBytes limits a single upload (50 MB) to protect the server.
const maxUploadBytes = 50 << 20

// loadDataSharingCfg reuses the stored AWS key/secret/region but targets the
// dedicated file-sharing bucket (overridable via DATA_SHARING_S3_URI) rather
// than the database-backup bucket held in aws_credentials.s3_uri.
func loadDataSharingCfg() backupCfg {
	c := backupCfg{}
	s3uri := "s3://mediascan-filestore/file_sharing"
	if v := os.Getenv("DATA_SHARING_S3_URI"); v != "" {
		s3uri = v
	}
	// AWS key/secret/region are shared with the backup feature.
	if row, _ := db.QueryOne("SELECT access_key_id, secret_access_key, region FROM aws_credentials ORDER BY id DESC LIMIT 1"); row != nil {
		c.awsKey = decryptOrRaw(strFromAny(row["access_key_id"]))
		c.awsSecret = decryptOrRaw(strFromAny(row["secret_access_key"]))
		c.awsRegion = strFromAny(row["region"])
	}
	// File-sharing overrides set on /admin/aws-credentials: a dedicated bucket
	// and (optionally) its own region, which takes precedence over the backup
	// region. Region auto-detection in the upload handler remains as a fallback.
	if cfgRow, _ := db.QueryOne("SELECT s3_uri, region FROM data_sharing_config WHERE id = 1"); cfgRow != nil {
		if u := strFromAny(cfgRow["s3_uri"]); u != "" {
			s3uri = u
		}
		if rg := strFromAny(cfgRow["region"]); rg != "" {
			c.awsRegion = rg
		}
	}
	c.bucket, c.prefix = parseS3URI(s3uri)
	return c
}

// sanitizeFileName keeps a safe subset of characters for an S3 object name.
func sanitizeFileName(name string) string {
	name = filepath.Base(name)
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '.', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" || out == ".xlsx" {
		out = "upload.xlsx"
	}
	return out
}

// POST /api/data-sharing/upload — upload an .xlsx to S3 and issue a 7-day link.
func DataSharingUpload(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes+(1<<20))
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		Fail(w, 413, "File too large or invalid upload (max 50 MB)")
		return
	}
	file, hdr, err := r.FormFile("file")
	if err != nil {
		Fail(w, 422, "No file was uploaded")
		return
	}
	defer file.Close()

	origName := filepath.Base(hdr.Filename)
	if !strings.HasSuffix(strings.ToLower(origName), ".xlsx") {
		Fail(w, 422, "Only .xlsx files are allowed")
		return
	}

	cfg := loadDataSharingCfg()
	if cfg.bucket == "" {
		Fail(w, 500, "The file-sharing S3 target is not configured.")
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	client, cerr := s3ClientFor(ctx, cfg)
	if cerr != nil {
		Fail(w, 500, "AWS is not configured correctly: "+cerr.Error())
		return
	}

	// The file-sharing bucket may live in a different region than the one stored
	// in aws_credentials (that region targets the backup bucket). Using the wrong
	// regional endpoint yields a PermanentRedirect, so resolve the bucket's actual
	// region and rebuild the client there when it differs.
	if region, rerr := manager.GetBucketRegion(ctx, client, cfg.bucket); rerr == nil && region != "" && region != cfg.awsRegion {
		log.Printf("[data-sharing] bucket %s is in %s (creds region %q) — switching", cfg.bucket, region, cfg.awsRegion)
		cfg.awsRegion = region
		if rc, rcerr := s3ClientFor(ctx, cfg); rcerr == nil {
			client = rc
		}
	}

	key := cfg.key(fmt.Sprintf("%s_%s", time.Now().UTC().Format("20060102_150405"), sanitizeFileName(origName)))

	uploader := manager.NewUploader(client)
	if _, uerr := uploader.Upload(ctx, &s3.PutObjectInput{
		Bucket:      awssdk.String(cfg.bucket),
		Key:         awssdk.String(key),
		Body:        file,
		ContentType: awssdk.String("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
	}); uerr != nil {
		log.Printf("[data-sharing] upload failed: %v", uerr)
		Fail(w, 502, "Upload to S3 failed: "+tail(uerr.Error(), 200))
		return
	}

	presigned, perr := s3.NewPresignClient(client).PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: awssdk.String(cfg.bucket),
		Key:    awssdk.String(key),
	}, s3.WithPresignExpires(presignMaxTTL))
	if perr != nil {
		log.Printf("[data-sharing] presign failed: %v", perr)
		Fail(w, 502, "Could not generate a share link: "+tail(perr.Error(), 200))
		return
	}

	uploadedBy := strings.TrimSpace(claims.LoginFirstName + " " + claims.LoginLastName)
	if uploadedBy == "" {
		uploadedBy = claims.LoginUsername
	}
	expiresAt := time.Now().UTC().Add(presignMaxTTL)

	if _, _, derr := db.Exec(`INSERT INTO data_sharing_history
		(login_id, user_id, uploaded_by, client_name, file_name, s3_key, file_size, presigned_url, url_expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		claims.LoginID, claims.UserID, uploadedBy, claims.ClientName,
		origName, key, hdr.Size, presigned.URL, expiresAt.Format("2006-01-02 15:04:05")); derr != nil {
		log.Printf("[data-sharing] history insert failed: %v", derr)
		// The file is already in S3 and the link is valid — don't fail the request.
	}

	// Raise it to the notification bell. The share link is deliberately NOT
	// included — a presigned URL grants access to the file to anyone holding
	// it, and the feed is read by more people than the uploader.
	pushNotify(claims, notify.Event{
		Type:    notify.TypeDataSharing,
		Title:   "File shared",
		Message: origName,
		Meta:    map[string]any{"fileName": origName, "fileSize": hdr.Size},
	})

	OK(w, map[string]any{
		"success":      true,
		"fileName":     origName,
		"presignedUrl": presigned.URL,
		"expiresAt":    expiresAt.Format(time.RFC3339),
		"message":      "File uploaded. Share link is valid for 7 days.",
	})
}

// GET /api/data-sharing/history — files shared by the current client account,
// newest first, with an `expired` flag derived from url_expires_at.
func DataSharingHistory(w http.ResponseWriter, r *http.Request) {
	claims := ClaimsFrom(r)
	if claims == nil {
		Fail(w, 401, "Not authenticated")
		return
	}
	rows, _ := db.Query(`SELECT id, uploaded_by, client_name, file_name, file_size,
		presigned_url, url_expires_at, created_at,
		(url_expires_at <= UTC_TIMESTAMP()) AS expired
		FROM data_sharing_history
		WHERE user_id = ?
		ORDER BY created_at DESC
		LIMIT 200`, claims.UserID)
	if rows == nil {
		rows = []map[string]any{}
	}
	OK(w, map[string]any{"success": true, "items": rows})
}
