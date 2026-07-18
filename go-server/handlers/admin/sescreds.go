package admin

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"

	ipauth "github.com/ip-house/iphouse-api/auth"
	"github.com/ip-house/iphouse-api/db"
	"github.com/ip-house/iphouse-api/email"
)

// Amazon SES credentials for outbound email. Mirrors the aws_credentials /
// AWSCredentials handler: single active row, access key id and secret
// encrypted at rest, secret only ever returned via the reveal endpoint.
// Sending only switches over to SES once is_active=1 — see email.getSESConfig.

// GET/POST /api/admin/ses-credentials
func SESCredentials(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		row, _ := db.QueryOne("SELECT id, access_key_id, secret_access_key, region, from_email, from_name, is_active, updated_at FROM ses_credentials ORDER BY id DESC LIMIT 1")
		if row == nil {
			ok(w, map[string]any{"success": true, "configured": false, "is_active": 0})
			return
		}
		ak := safeDecryptMain(row["access_key_id"])
		ok(w, map[string]any{
			"success":     true,
			"configured":  ak != "",
			"accessKeyId": maskAKID(ak),
			"region":      strVal(row["region"]),
			"fromEmail":   strVal(row["from_email"]),
			"fromName":    strVal(row["from_name"]),
			"hasSecret":   safeDecryptMain(row["secret_access_key"]) != "",
			"is_active":   row["is_active"],
			"updatedAt":   strVal(row["updated_at"]),
		})

	case http.MethodPost:
		var body struct {
			AccessKeyId     string `json:"accessKeyId"`
			SecretAccessKey string `json:"secretAccessKey"`
			Region          string `json:"region"`
			FromEmail       string `json:"fromEmail"`
			FromName        string `json:"fromName"`
			IsActive        int    `json:"isActive"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		body.AccessKeyId = strings.TrimSpace(body.AccessKeyId)
		body.Region = strings.TrimSpace(body.Region)
		body.FromEmail = strings.TrimSpace(body.FromEmail)
		body.FromName = strings.TrimSpace(body.FromName)
		if body.AccessKeyId == "" || body.Region == "" || body.FromEmail == "" {
			fail(w, 422, "Access Key ID, Region and From Email are required")
			return
		}

		existing, _ := db.QueryOne("SELECT id, secret_access_key FROM ses_credentials ORDER BY id DESC LIMIT 1")

		// A blank secret on update means "keep the existing one" — the GET never
		// returns the real secret, so a blank submit must not wipe it.
		secretEnc := ""
		if strings.TrimSpace(body.SecretAccessKey) != "" {
			secretEnc = ipauth.EncryptMain(strings.TrimSpace(body.SecretAccessKey))
		} else if existing != nil {
			secretEnc, _ = existing["secret_access_key"].(string)
		}
		if secretEnc == "" {
			fail(w, 422, "Secret Access Key is required")
			return
		}

		akEnc := ipauth.EncryptMain(body.AccessKeyId)
		if existing != nil {
			if err := db.MustExec("UPDATE ses_credentials SET access_key_id=?, secret_access_key=?, region=?, from_email=?, from_name=?, is_active=? WHERE id=?",
				akEnc, secretEnc, body.Region, body.FromEmail, body.FromName, body.IsActive, intVal(existing["id"])); err != nil {
				fail(w, 500, "Could not save SES credentials")
				return
			}
		} else {
			if err := db.MustExec("INSERT INTO ses_credentials (access_key_id, secret_access_key, region, from_email, from_name, is_active) VALUES (?, ?, ?, ?, ?, ?)",
				akEnc, secretEnc, body.Region, body.FromEmail, body.FromName, body.IsActive); err != nil {
				fail(w, 500, "Could not save SES credentials")
				return
			}
		}
		ok(w, map[string]any{"success": true})

	default:
		fail(w, 405, "Method not allowed")
	}
}

// GET /api/admin/ses-credentials/reveal — decrypted access key + secret (on demand).
func SESCredentialsReveal(w http.ResponseWriter, r *http.Request) {
	row, _ := db.QueryOne("SELECT id, access_key_id, secret_access_key FROM ses_credentials ORDER BY id DESC LIMIT 1")
	if row == nil {
		fail(w, 404, "No SES credentials configured")
		return
	}
	logReveal(r, "ses", "ses_credentials")
	ok(w, map[string]any{
		"success":         true,
		"accessKeyId":     safeDecryptMain(row["access_key_id"]),
		"secretAccessKey": safeDecryptMain(row["secret_access_key"]),
	})
}

// POST /api/admin/ses-credentials/test — sends a real test email through the
// currently saved SES credentials, regardless of is_active, so an admin can
// verify the configuration before switching production sending over to it.
func SESCredentialsTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		To string `json:"to"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	body.To = strings.TrimSpace(body.To)
	if body.To == "" {
		fail(w, 422, "A recipient email address is required")
		return
	}

	row, _ := db.QueryOne("SELECT access_key_id, secret_access_key, region, from_email, from_name FROM ses_credentials ORDER BY id DESC LIMIT 1")
	if row == nil {
		fail(w, 404, "No SES credentials configured")
		return
	}
	key := safeDecryptMain(row["access_key_id"])
	secret := safeDecryptMain(row["secret_access_key"])
	region := strVal(row["region"])
	fromEmail := strVal(row["from_email"])
	fromName := strVal(row["from_name"])
	if key == "" || secret == "" || region == "" || fromEmail == "" {
		fail(w, 422, "SES credentials are incomplete — save Access Key, Secret, Region and From Email first")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if _, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(key, secret, "")),
	); err != nil {
		fail(w, 500, "Could not build AWS session: "+err.Error())
		return
	}

	if err := email.SendSESTest(ctx, key, secret, region, fromEmail, fromName, body.To); err != nil {
		fail(w, 502, "Test email failed: "+err.Error())
		return
	}
	ok(w, map[string]any{"success": true, "message": "Test email sent to " + body.To})
}
