package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/config"
	"github.com/ip-house/iphouse-api/db"
)

// Database backup: streams a mysqldump of the app database straight to S3 (the
// same pipeline as the ops shell script), and lists the backups already stored
// there. Super-Admin only — registered under saAuth in main.go. No value from
// the request ever enters the shell command, so there is no injection surface.
//
// AWS credentials are read from the encrypted aws_credentials table (managed on
// the AWS Credentials configuration page); if none are stored, the aws CLI's
// ambient config (e.g. the instance IAM role) is used. The aws CLI is installed
// on demand the first time a backup runs, if it isn't already present.

type backupCfg struct {
	host, user, pass, name string
	bucket, prefix         string
	awsKey, awsSecret, awsRegion string
}

// loadBackupCfg reads DB settings from the environment (defaulting to the app's
// own connection) and AWS settings from the encrypted aws_credentials table
// (falling back to BACKUP_S3_URI / ambient AWS config).
func loadBackupCfg() backupCfg {
	get := func(k, def string) string {
		if v := os.Getenv(k); v != "" {
			return v
		}
		return def
	}
	c := backupCfg{
		host: get("BACKUP_DB_HOST", config.C.DBHost),
		user: get("BACKUP_DB_USER", config.C.DBUser),
		pass: get("BACKUP_DB_PASS", config.C.DBPass),
		name: get("BACKUP_DB_NAME", config.C.DBName),
	}

	s3uri := get("BACKUP_S3_URI", "s3://powerbi-backup-db/database-backup")
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

// awsEnv returns the process environment for aws/mysqldump: the app env plus a
// broadened PATH (a systemd service often has a minimal PATH that misses where
// mysqldump / a user-installed aws live), MYSQL_PWD, and — when stored
// credentials exist — the AWS_* variables. Secrets go via the environment so
// they stay off the command line and out of logs.
func (c backupCfg) awsEnv() []string {
	env := withEnv(os.Environ(), "PATH", augmentedPath())
	env = withEnv(env, "MYSQL_PWD", c.pass)
	if c.awsKey != "" && c.awsSecret != "" {
		env = withEnv(env, "AWS_ACCESS_KEY_ID", c.awsKey)
		env = withEnv(env, "AWS_SECRET_ACCESS_KEY", c.awsSecret)
		if c.awsRegion != "" {
			env = withEnv(env, "AWS_DEFAULT_REGION", c.awsRegion)
			env = withEnv(env, "AWS_REGION", c.awsRegion)
		}
	}
	return env
}

// withEnv sets key=val in an environment slice, replacing any existing entry.
func withEnv(env []string, key, val string) []string {
	pref := key + "="
	out := make([]string, 0, len(env)+1)
	found := false
	for _, e := range env {
		if strings.HasPrefix(e, pref) {
			out = append(out, pref+val)
			found = true
		} else {
			out = append(out, e)
		}
	}
	if !found {
		out = append(out, pref+val)
	}
	return out
}

// commonBinDirs are the usual locations for CLI tools, prepended to PATH so the
// backup works even when the server process starts with a bare PATH.
func commonBinDirs() []string {
	return []string{
		"/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
		"/snap/bin", "/usr/local/mysql/bin", "/usr/local/mariadb/bin",
		homeDir() + "/.local/bin",
	}
}

func augmentedPath() string {
	cur := os.Getenv("PATH")
	joined := strings.Join(commonBinDirs(), string(os.PathListSeparator))
	if cur == "" {
		return joined
	}
	return cur + string(os.PathListSeparator) + joined
}

// findBin locates a binary by name: an explicit env override, then PATH, then
// the common install directories. Returns "" when not found.
func findBin(name, envOverride string) string {
	if envOverride != "" {
		if p := os.Getenv(envOverride); p != "" {
			if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
				return p
			}
		}
	}
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, d := range commonBinDirs() {
		p := d + "/" + name
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// ensureMysqldump returns a usable mysqldump path, attempting a best-effort
// install of the MySQL client (needs passwordless sudo) if it's genuinely
// missing on Linux. Returns a clear, actionable error otherwise.
func ensureMysqldump(ctx context.Context) (string, error) {
	if p := findBin("mysqldump", "MYSQLDUMP_PATH"); p != "" {
		return p, nil
	}
	if runtime.GOOS != "linux" {
		return "", fmt.Errorf("mysqldump was not found on the server")
	}
	log.Printf("[backup] mysqldump not found — attempting install of the MySQL client")
	script := `set -e
if command -v apt-get >/dev/null 2>&1; then
  sudo -n apt-get update -y
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y default-mysql-client || \
  sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y mysql-client
elif command -v dnf >/dev/null 2>&1; then
  sudo -n dnf install -y mysql
elif command -v yum >/dev/null 2>&1; then
  sudo -n yum install -y mysql
else
  echo "no supported package manager (apt/dnf/yum) found" >&2; exit 1
fi`
	cmd := exec.CommandContext(ctx, "bash", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("mysqldump is not installed and auto-install failed (%s). Install it on the server, e.g. `sudo apt-get install -y default-mysql-client`", tail(string(out), 200))
	}
	if p := findBin("mysqldump", "MYSQLDUMP_PATH"); p != "" {
		log.Printf("[backup] mysqldump installed at %s", p)
		return p, nil
	}
	return "", fmt.Errorf("mysqldump still not found after install; set MYSQLDUMP_PATH to its full path")
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

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return "…" + s[len(s)-n:]
	}
	return s
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	if h := os.Getenv("HOME"); h != "" {
		return h
	}
	return "/tmp"
}

// findAWS returns the path to an existing aws binary, or "" if none is present.
// It does not install anything.
func findAWS() string {
	if p := os.Getenv("AWS_CLI_PATH"); p != "" {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	if p, err := exec.LookPath("aws"); err == nil {
		return p
	}
	for _, p := range []string{"/usr/local/bin/aws", "/usr/bin/aws", homeDir() + "/.local/bin/aws"} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

// ensureAWS returns a usable aws binary path, installing AWS CLI v2 on demand
// (user-local, no sudo) when it isn't already present. Linux only.
func ensureAWS(ctx context.Context) (string, error) {
	if p := findAWS(); p != "" {
		return p, nil
	}
	if runtime.GOOS != "linux" {
		return "", fmt.Errorf("the AWS CLI is not installed and auto-install is only supported on Linux")
	}
	for _, t := range []string{"curl", "unzip"} {
		if _, err := exec.LookPath(t); err != nil {
			return "", fmt.Errorf("cannot auto-install the AWS CLI: %q is required on the server but is missing", t)
		}
	}

	home := homeDir()
	instDir := home + "/.local/aws-cli"
	binDir := home + "/.local/bin"
	// Download and install AWS CLI v2 into a user-owned directory (no sudo).
	script := fmt.Sprintf(`set -e
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
arch=$(uname -m)
case "$arch" in
  x86_64) url="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;;
  aarch64|arm64) url="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
curl -fsSL "$url" -o awscliv2.zip
unzip -q awscliv2.zip
./aws/install --update -i %s -b %s`, shellQuote(instDir), shellQuote(binDir))

	log.Printf("[backup] AWS CLI not found — installing to %s", binDir)
	cmd := exec.CommandContext(ctx, "bash", "-c", script)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("AWS CLI install failed: %s", tail(string(out), 300))
	}
	awsPath := binDir + "/aws"
	if fi, err := os.Stat(awsPath); err != nil || fi.IsDir() {
		return "", fmt.Errorf("AWS CLI install completed but the binary was not found at %s", awsPath)
	}
	log.Printf("[backup] AWS CLI installed at %s", awsPath)
	return awsPath, nil
}

// POST /api/admin/backup/run — take a fresh backup and upload it to S3.
func RunBackup(w http.ResponseWriter, r *http.Request) {
	cfg := loadBackupCfg()
	if cfg.bucket == "" {
		Fail(w, 500, "The backup S3 target is not configured. Set it on the AWS Credentials page."); return
	}

	// Detached from the request context so a client/proxy disconnect can't abort
	// the install or backup mid-stream.
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Minute)
	defer cancel()

	dumpPath, err := ensureMysqldump(ctx)
	if err != nil {
		Fail(w, 500, err.Error()); return
	}
	awsPath, err := ensureAWS(ctx)
	if err != nil {
		Fail(w, 500, err.Error()); return
	}

	file := fmt.Sprintf("%s_%s.sql", cfg.name, time.Now().Format("2006-01-02_15-04-05"))
	dest := fmt.Sprintf("s3://%s/%s/%s", cfg.bucket, cfg.prefix, file)

	// --single-transaction --quick: consistent, low-lock dump of a live InnoDB
	// database. pipefail makes the pipeline fail if mysqldump fails, so a broken
	// dump is never silently uploaded. Both binaries are invoked by absolute
	// path so a minimal service PATH can't break the pipeline.
	pipeline := fmt.Sprintf(
		"set -o pipefail; %s -h %s -u %s --single-transaction --quick --routines --events %s | %s s3 cp - %s",
		shellQuote(dumpPath), shellQuote(cfg.host), shellQuote(cfg.user), shellQuote(cfg.name), shellQuote(awsPath), shellQuote(dest))

	start := time.Now()
	cmd := exec.CommandContext(ctx, "bash", "-c", pipeline)
	cmd.Env = cfg.awsEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[backup] FAILED after %s: %v | output: %s", time.Since(start).Round(time.Second), err, tail(string(out), 600))
		Fail(w, 502, "Backup failed: "+tail(string(out), 300)); return
	}

	dur := time.Since(start).Round(time.Second).String()
	log.Printf("[backup] uploaded %s in %s", dest, dur)
	OK(w, map[string]any{
		"success": true, "file": file, "destination": dest, "duration": dur,
		"message": "Backup completed and uploaded to S3.",
	})
}

// GET /api/admin/backup/list — list the backups already stored in S3.
func ListBackups(w http.ResponseWriter, r *http.Request) {
	cfg := loadBackupCfg()
	if cfg.bucket == "" {
		Fail(w, 500, "The backup S3 target is not configured. Set it on the AWS Credentials page."); return
	}
	awsPath := findAWS()
	if awsPath == "" {
		Fail(w, 503, "The AWS CLI is not installed yet. Run a backup once to install it, or install it on the server."); return
	}

	prefix := cfg.prefix
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, awsPath, "s3api", "list-objects-v2",
		"--bucket", cfg.bucket, "--prefix", prefix, "--output", "json")
	cmd.Env = cfg.awsEnv()
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[backup] list failed: %v | %s", err, tail(string(out), 400))
		Fail(w, 502, "Could not list backups from S3: "+tail(string(out), 250)); return
	}

	var parsed struct {
		Contents []struct {
			Key          string `json:"Key"`
			Size         int64  `json:"Size"`
			LastModified string `json:"LastModified"`
			StorageClass string `json:"StorageClass"`
		} `json:"Contents"`
	}
	json.Unmarshal(out, &parsed)

	backups := make([]map[string]any, 0, len(parsed.Contents))
	for _, c := range parsed.Contents {
		name := c.Key
		if i := strings.LastIndex(name, "/"); i >= 0 {
			name = name[i+1:]
		}
		if name == "" {
			continue
		}
		backups = append(backups, map[string]any{
			"name": name, "key": c.Key, "size": c.Size,
			"lastModified": c.LastModified, "storageClass": c.StorageClass,
		})
	}
	sort.Slice(backups, func(i, j int) bool {
		return strFromAny(backups[i]["lastModified"]) > strFromAny(backups[j]["lastModified"])
	})

	OK(w, map[string]any{
		"success": true, "bucket": cfg.bucket, "prefix": cfg.prefix,
		"count": len(backups), "backups": backups,
	})
}
