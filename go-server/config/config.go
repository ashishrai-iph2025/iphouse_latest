package config

import (
	"log"
	"os"
	"strconv"
)

type Config struct {
	DBHost     string
	DBPort     string
	DBUser     string
	DBPass     string
	DBName     string
	JWTSecret  string
	MarkscanBase string
	SMTPHost   string
	SMTPPort   int
	SMTPSecure bool
	SMTPUser   string
	SMTPPass   string
	SMTPFrom   string
	SessionIdleSeconds int
	EncryptionKey string
	APICredKey    string
	APICredIV     string
	Port          string
	RedisAddr     string
}

var C Config

func Load() {
	isProd := os.Getenv("USE_PRODUCTION_DB") == "true"

	if isProd {
		C.DBHost = getEnv("DB_HOST_PROD", "localhost")
		C.DBPort = getEnv("DB_PORT_PROD", "3306")
		C.DBUser = getEnv("DB_USER_PROD", "root")
		C.DBPass = getEnv("DB_PASS_PROD", "")
		C.DBName = getEnv("DB_NAME_PROD", "dashboard")
	} else {
		C.DBHost = getEnv("DB_HOST_LOCAL", getEnv("DB_HOST", "localhost"))
		C.DBPort = getEnv("DB_PORT_LOCAL", getEnv("DB_PORT", "3306"))
		C.DBUser = getEnv("DB_USER_LOCAL", getEnv("DB_USER", "root"))
		C.DBPass = getEnv("DB_PASS_LOCAL", getEnv("DB_PASS", ""))
		C.DBName = getEnv("DB_NAME_LOCAL", getEnv("DB_NAME", "dashboard"))
	}

	C.JWTSecret = getEnv("NEXTAUTH_SECRET", os.Getenv("JWT_SECRET"))
	if C.JWTSecret == "" {
		log.Fatal("[config] JWT secret is not set — set NEXTAUTH_SECRET or JWT_SECRET env var")
	}
	// A weak or placeholder JWT secret lets anyone forge session tokens. Refuse to
	// start in production with the shipped default or a too-short secret; warn loudly
	// otherwise so local dev still runs.
	const placeholderSecret = "change_this_to_a_long_random_string_min_32_chars"
	if C.JWTSecret == placeholderSecret || len(C.JWTSecret) < 32 {
		msg := "[config] INSECURE JWT secret: it is the shipped placeholder or shorter than 32 chars. " +
			"Generate a strong random value (e.g. `openssl rand -base64 48`) and set NEXTAUTH_SECRET."
		if isProd {
			log.Fatal(msg + " Refusing to start in production.")
		}
		log.Println("WARNING " + msg)
	}
	C.MarkscanBase     = getEnv("MARKSCAN_API_BASE", "https://api.markscan.co.in")
	C.SMTPHost         = getEnv("SMTP_HOST", "localhost")
	C.SMTPPort         = getEnvInt("SMTP_PORT", 587)
	C.SMTPSecure       = os.Getenv("SMTP_SECURE") == "true" || os.Getenv("SMTP_SECURE") == "ssl"
	C.SMTPUser         = getEnv("SMTP_USER", "")
	C.SMTPPass         = getEnv("SMTP_PASS", "")
	C.SMTPFrom         = getEnv("SMTP_FROM", "IP House <noreply@iphouse.com>")
	C.SessionIdleSeconds = getEnvInt("SESSION_IDLE_TIMEOUT_SECONDS", 1800)
	C.EncryptionKey    = getEnv("ENCRYPTION_KEY", "")
	C.APICredKey       = getEnv("API_CRED_KEY", "")
	C.APICredIV        = getEnv("API_CRED_IV", "")
	C.Port             = getEnv("GO_PORT", "8080")
	C.RedisAddr        = getEnv("REDIS_ADDR", "")
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return fallback
}
