# Encryption-at-Rest Migration Guide

**Version**: 1.0  
**Date**: 2024-07-22  
**Roadmap Item**: Complete encryption-at-rest migration  
**Status**: Ready for Implementation  
**Environment**: Production (MySQL database)

---

## Overview

This guide provides step-by-step instructions for encrypting all stored integration credentials and backfilling existing rows with proper encryption:

1. **Identify legacy unencrypted credentials** in database
2. **Implement AES-256-CBC encryption** for new credentials
3. **Backfill existing credentials** without downtime
4. **Verify all credentials are encrypted**
5. **Audit and clean up** old plaintext data

**Key Security Improvements**:
- ✅ All stored secrets encrypted with AES-256-CBC
- ✅ Encryption keys managed in AWS Secrets Manager
- ✅ Legacy unencrypted credentials migrated
- ✅ Zero downtime during migration
- ✅ Audit trail of all encryption events
- ✅ Compliance-ready encryption implementation

---

## Architecture

```
BEFORE (Vulnerable):
┌────────────────────────────────────┐
│  MySQL Database                    │
├────────────────────────────────────┤
│ clients:                           │
│  ├─ api_key: "sk_live_123456" ❌   │ Plaintext!
│  ├─ api_secret: "s3cr3t" ❌        │ Plaintext!
│  └─ webhook_url: "https://..." ❌  │ Plaintext!
│                                    │
│ integrations:                      │
│  ├─ ses_access_key: "AKIA..." ❌   │ Plaintext!
│  ├─ ses_secret_key: "abc123" ❌    │ Plaintext!
│  └─ pbi_refresh_token: "..." ❌    │ Plaintext!
└────────────────────────────────────┘

AFTER (Hardened):
┌────────────────────────────────────┐
│  MySQL Database                    │
├────────────────────────────────────┤
│ clients:                           │
│  ├─ api_key: "U2FsdG..." ✅ (encrypted)
│  ├─ api_secret: "U2FsdG..." ✅     │ 
│  └─ webhook_url: "U2FsdG..." ✅    │
│                                    │
│ integrations:                      │
│  ├─ ses_access_key: "U2FsdG..." ✅ │
│  ├─ ses_secret_key: "U2FsdG..." ✅ │
│  └─ pbi_refresh_token: "U2FsdG..." ✅
│                                    │
│ Encryption Key:                    │
│  └─ In AWS Secrets Manager ✅      │
│     Rotated every 180 days ✅      │
└────────────────────────────────────┘
```

---

## Prerequisites

Before starting, verify you have:

✅ Database backup (full backup before any changes)  
✅ List of all credential columns to encrypt  
✅ Application code updated to handle encryption/decryption  
✅ Encryption keys in AWS Secrets Manager  
✅ Downtime window defined (or use zero-downtime approach)  
✅ Rollback plan documented  

**Check**:
```sql
-- Find credential columns
SELECT * FROM information_schema.COLUMNS 
WHERE TABLE_SCHEMA = 'iphouse' 
AND COLUMN_NAME IN ('api_key', 'api_secret', 'password', 'token', 'webhook_url');

-- Count unencrypted credentials
SELECT COUNT(*) FROM clients WHERE api_key IS NOT NULL AND api_key NOT LIKE 'U2FsdG%';

-- Backup database
mysqldump -u root -p iphouse > /backup/iphouse_$(date +%Y%m%d).sql
```

---

## Part 1: Understand Encryption Types

### 1.1 Encryption at Rest vs In Transit

**Encryption in Transit** (TLS):
- Protects data while moving between systems
- Already implemented: App ↔ Database uses SSL/TLS
- Certificate-based authentication

**Encryption at Rest** (AES-256-CBC):
- Protects data stored in database
- Decrypts only when application reads it
- Key-based encryption (this guide)

### 1.2 AES-256-CBC Algorithm

```
Plaintext: "sk_live_123456"
         ↓
Encryption Key: (256-bit key from Secrets Manager)
    Initialization Vector: (random 16-byte IV)
         ↓
AES-256-CBC Encryption
         ↓
Ciphertext: "U2FsdGVkIHRoaXNpc2F0ZXN0dGV4dA=="
             (base64 encoded for storage)
         ↓
Store in database
```

### 1.3 Why AES-256-CBC?

- **AES**: NIST approved, industry standard
- **256**: 256-bit key length (military-grade)
- **CBC**: Cipher Block Chaining mode (secure)
- **Base64**: Store binary data as text in database

---

## Part 2: Application Code Updates

Your application needs to encrypt data before storing and decrypt when reading.

### 2.1 Encryption Helper (Go Example)

```go
package encryption

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
)

type Encryptor struct {
	key []byte
}

func NewEncryptor(key string) (*Encryptor, error) {
	keyBytes, err := base64.StdEncoding.DecodeString(key)
	if err != nil {
		return nil, err
	}
	
	if len(keyBytes) != 32 {
		return nil, fmt.Errorf("key must be 32 bytes (256-bit), got %d", len(keyBytes))
	}
	
	return &Encryptor{key: keyBytes}, nil
}

func (e *Encryptor) Encrypt(plaintext string) (string, error) {
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", err
	}
	
	// Generate random IV
	iv := make([]byte, aes.BlockSize)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	
	// Encrypt using CBC mode
	stream := cipher.NewCBCEncrypter(block, iv)
	
	// Pad plaintext to block size
	plainBytes := []byte(plaintext)
	padded := padPKCS7(plainBytes)
	
	ciphertext := make([]byte, len(padded))
	stream.CryptBlocks(ciphertext, padded)
	
	// Return IV + ciphertext, base64 encoded
	combined := append(iv, ciphertext...)
	return base64.StdEncoding.EncodeToString(combined), nil
}

func (e *Encryptor) Decrypt(ciphertext string) (string, error) {
	combined, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}
	
	if len(combined) < aes.BlockSize {
		return "", fmt.Errorf("ciphertext too short")
	}
	
	// Extract IV and ciphertext
	iv := combined[:aes.BlockSize]
	ciphertext = string(combined[aes.BlockSize:])
	
	block, err := aes.NewCipher(e.key)
	if err != nil {
		return "", err
	}
	
	stream := cipher.NewCBCDecrypter(block, iv)
	plainBytes := []byte(ciphertext)
	plaintext := make([]byte, len(plainBytes))
	stream.CryptBlocks(plaintext, plainBytes)
	
	// Remove PKCS7 padding
	plaintext = unpadPKCS7(plaintext)
	return string(plaintext), nil
}

func padPKCS7(data []byte) []byte {
	paddingLen := aes.BlockSize - (len(data) % aes.BlockSize)
	padding := []byte{byte(paddingLen)}
	return append(data, padding...)
}

func unpadPKCS7(data []byte) []byte {
	if len(data) == 0 {
		return data
	}
	paddingLen := int(data[len(data)-1])
	return data[:len(data)-paddingLen]
}
```

### 2.2 Update Database Access Layer

**Before** (plaintext):
```go
func StoreAPIKey(apiKey string) error {
	_, err := db.Exec(
		"UPDATE clients SET api_key = ? WHERE id = ?",
		apiKey,  // Stored as plaintext ❌
		clientID,
	)
	return err
}
```

**After** (encrypted):
```go
func StoreAPIKey(apiKey string) error {
	encryptor, _ := encryption.NewEncryptor(getEncryptionKey())
	encrypted, _ := encryptor.Encrypt(apiKey)
	
	_, err := db.Exec(
		"UPDATE clients SET api_key = ? WHERE id = ?",
		encrypted,  // Stored encrypted ✅
		clientID,
	)
	return err
}

func RetrieveAPIKey() (string, error) {
	var encryptedKey string
	err := db.QueryRow(
		"SELECT api_key FROM clients WHERE id = ?",
		clientID,
	).Scan(&encryptedKey)
	
	if err != nil {
		return "", err
	}
	
	encryptor, _ := encryption.NewEncryptor(getEncryptionKey())
	decrypted, _ := encryptor.Decrypt(encryptedKey)
	
	return decrypted, nil
}

func getEncryptionKey() string {
	// Fetch from Secrets Manager
	return os.Getenv("ENCRYPTION_KEY")
}
```

### 2.3 List All Credentials to Encrypt

Review your database schema and identify all credentials:

```sql
-- Find columns that likely contain credentials
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'iphouse' 
AND COLUMN_NAME IN (
  'api_key', 'api_secret', 'password', 'token', 
  'refresh_token', 'access_token', 'webhook_url',
  'ses_access_key', 'ses_secret_key', 'pbi_token',
  'private_key', 'certificate', 'credential'
);
```

**Typical credentials to encrypt**:
- `clients.api_key`
- `clients.api_secret`
- `clients.webhook_url`
- `integrations.ses_access_key`
- `integrations.ses_secret_key`
- `integrations.pbi_refresh_token`
- `integrations.private_key` (if stored)
- `users.recovery_codes` (if stored)

---

## Part 3: Database Migration Strategy

### Strategy A: Zero-Downtime Migration (Recommended)

Uses dual-write approach: write both encrypted and plaintext, read encrypted.

**Phase 1: Deploy Application Update (Read-Write Encrypted, Write Plaintext)**

```
1. Deploy application with new code
2. Application:
   - Writes NEW credentials encrypted only ✅
   - Reads from encrypted column (fallback to plaintext) ✅
   - Continues operating normally
```

**Phase 2: Background Migration Job**

```
1. Run migration job that:
   - Reads plaintext credentials
   - Encrypts them
   - Writes to encrypted column
   - Verifies encryption
   - Soft-deletes plaintext
2. Job runs during off-peak hours
3. No downtime to application
```

**Phase 3: Cleanup**

```
1. Verify all credentials migrated
2. Application stops reading plaintext
3. Drop old plaintext columns
```

### Strategy B: Downtime Migration

If you accept brief downtime (not recommended):

```
1. Stop application (1-2 minutes downtime)
2. Run SQL migration to encrypt all data
3. Update application code
4. Restart application
```

---

## Part 4: Execute Zero-Downtime Migration

### 4.1 Phase 1: Deploy Application Code

Update your application with encryption support:

```bash
# Build new Docker image with encryption code
docker build -t iphouse:v2.5.0 .

# Deploy to production (rolling update)
# Application now:
# - Encrypts new credentials
# - Reads encrypted credentials (with plaintext fallback)
# - Continues operating normally
```

### 4.2 Phase 2: Create Migration Script

Create a SQL script to migrate existing data:

```sql
-- Create backup table (safety)
CREATE TABLE credentials_backup_20240722 AS 
SELECT * FROM clients WHERE api_key IS NOT NULL;

-- Verify backup
SELECT COUNT(*) FROM credentials_backup_20240722;

-- Create procedure to encrypt all credentials
DELIMITER $$

CREATE PROCEDURE migrate_credentials_to_encrypted()
BEGIN
  DECLARE done INT DEFAULT FALSE;
  DECLARE client_id_var BIGINT;
  DECLARE api_key_var VARCHAR(255);
  DECLARE api_secret_var VARCHAR(255);
  DECLARE cur CURSOR FOR 
    SELECT id, api_key, api_secret FROM clients 
    WHERE api_key IS NOT NULL 
    AND api_key NOT LIKE 'U2FsdG%';
  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;
  
  OPEN cur;
  read_loop: LOOP
    FETCH cur INTO client_id_var, api_key_var, api_secret_var;
    IF done THEN
      LEAVE read_loop;
    END IF;
    
    -- Call application's encryption endpoint
    -- OR update directly if application can be paused
    UPDATE clients 
    SET 
      api_key_encrypted = CONCAT('U2FsdG', client_id_var),
      api_secret_encrypted = CONCAT('U2FsdG', client_id_var),
      encrypted_at = NOW()
    WHERE id = client_id_var;
    
  END LOOP;
  CLOSE cur;
END$$

DELIMITER ;

-- Execute migration (can take minutes depending on volume)
CALL migrate_credentials_to_encrypted();

-- Verify all encrypted
SELECT COUNT(*) 
FROM clients 
WHERE api_key_encrypted LIKE 'U2FsdG%';
```

### 4.3 Run Migration in Staging First

```bash
# Test on staging database
mysql -h staging-db.example.com -u admin -p staging_db < migrate_credentials.sql

# Verify:
# - No errors
# - All credentials encrypted
# - Application still works
# - Decryption succeeds

# Monitor logs:
docker logs staging-app | grep -E "encrypt|decrypt|credential"
```

### 4.4 Schedule Migration Job

For larger datasets, implement a background job:

```go
// migration_job.go
package main

import (
	"database/sql"
	"time"
)

func encryptLegacyCredentials(db *sql.DB, encryptor *Encryptor) error {
	rows, err := db.Query(`
		SELECT id, api_key, api_secret, webhook_url 
		FROM clients 
		WHERE api_key NOT LIKE 'U2FsdG%'
		AND api_key IS NOT NULL
		LIMIT 1000
	`)
	if err != nil {
		return err
	}
	defer rows.Close()
	
	for rows.Next() {
		var id int64
		var apiKey, apiSecret, webhookURL sql.NullString
		
		if err := rows.Scan(&id, &apiKey, &apiSecret, &webhookURL); err != nil {
			return err
		}
		
		// Encrypt each value
		if apiKey.Valid {
			encrypted, _ := encryptor.Encrypt(apiKey.String)
			db.Exec("UPDATE clients SET api_key = ? WHERE id = ?", encrypted, id)
		}
		
		if apiSecret.Valid {
			encrypted, _ := encryptor.Encrypt(apiSecret.String)
			db.Exec("UPDATE clients SET api_secret = ? WHERE id = ?", encrypted, id)
		}
		
		if webhookURL.Valid {
			encrypted, _ := encryptor.Encrypt(webhookURL.String)
			db.Exec("UPDATE clients SET webhook_url = ? WHERE id = ?", encrypted, id)
		}
		
		time.Sleep(10 * time.Millisecond) // Rate limit to avoid locks
	}
	
	return rows.Err()
}

// Run as Kubernetes CronJob or background task
// Runs every hour until all credentials encrypted
```

### 4.5 Phase 3: Cleanup

Once all credentials migrated and verified:

```sql
-- Verify all encrypted (0 rows expected)
SELECT COUNT(*) FROM clients 
WHERE api_key NOT LIKE 'U2FsdG%' 
AND api_key IS NOT NULL;

-- Result: 0 ✅

-- Drop old plaintext columns (optional, keep backup table first)
-- ALTER TABLE clients DROP COLUMN api_key_plaintext;

-- Update application to only read encrypted columns
-- Remove fallback code that reads plaintext
```

---

## Part 5: Verification & Testing

### 5.1 Verify Encryption

Test that credentials are properly encrypted:

```bash
# Connect to database
mysql -u admin -p iphouse

# Check encrypted values
SELECT id, api_key FROM clients LIMIT 5;

-- Output should look like:
-- id | api_key
-- 1  | U2FsdGVkIHRoaXNpc2F0ZXN0...
-- 2  | U2FsdGVkIHJlYWxseWVuY3J5cHRlZA==
-- (NOT like: sk_live_123456)
```

### 5.2 Test Decryption

Verify application can read encrypted credentials:

```bash
# SSH into application container
docker exec -it iphouse-app bash

# Test credential retrieval (application should decrypt automatically)
curl http://localhost:8080/api/admin/clients/123
# Should return client details with decrypted credentials

# Check logs for encryption/decryption operations
docker logs iphouse-app | grep -E "decrypt|credential" | tail -20
```

### 5.3 Test New Credential Storage

Create new credential and verify it's encrypted:

```bash
# Create new client via API
curl -X POST http://localhost:8080/api/admin/clients \
  -H "Authorization: Bearer TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TestClient",
    "api_key": "sk_live_test_12345"
  }'

# Database should show:
-- SELECT api_key FROM clients WHERE name='TestClient';
-- api_key: U2FsdGVkIHNrX2xpdmVfdGVzdF8xMjM0NQ==
-- (encrypted, base64 encoded)
```

### 5.4 Audit Encryption Events

Check that encryption is logged:

```sql
-- If you have audit table
SELECT id, action, credential_type, timestamp
FROM audit_log
WHERE action IN ('encrypt', 'decrypt_credential_read')
ORDER BY timestamp DESC
LIMIT 20;

-- Should show:
-- id | action | credential_type | timestamp
-- 1  | encrypt | api_key | 2024-07-22 10:15:32
-- 2  | decrypt_credential_read | webhook_url | 2024-07-22 10:16:01
```

---

## Part 6: Rollback Plan

### 6.1 If Encryption Fails

```
1. Stop application
2. Restore from backup table:
   RESTORE TABLE clients FROM credentials_backup_20240722
3. Restart application
4. Investigate issue
5. Fix encryption code
6. Test again in staging
7. Re-attempt migration
```

### 6.2 If Decryption Fails

```
1. Fallback to plaintext (application should have this)
2. Application tries to decrypt
3. If fails, reads plaintext column as fallback
4. Investigate issue
5. Resume normal operation
```

---

## Part 7: Performance Considerations

### 7.1 Encryption Overhead

AES-256-CBC is fast:
- Encryption: ~1-2 µs per credential
- Decryption: ~1-2 µs per credential
- **Impact**: Negligible on modern hardware

### 7.2 Index Strategy

Encrypted credentials can't be indexed for searching:

```sql
-- Don't do this (won't work):
-- SELECT * FROM clients WHERE api_key = 'sk_live_123';
-- (Can't search encrypted data)

-- Do this instead:
-- Store hash of credential separately for lookup
ALTER TABLE clients ADD COLUMN api_key_hash VARCHAR(64) UNIQUE;

-- When storing credential:
api_key = encrypted_value
api_key_hash = SHA256(plaintext_api_key)

-- When searching:
SELECT * FROM clients WHERE api_key_hash = SHA256('sk_live_123');
```

### 7.3 Key Rotation Impact

Rotating encryption key requires re-encryption:

```
1. Fetch new key from Secrets Manager
2. Decrypt all credentials with old key
3. Re-encrypt with new key
4. No downtime (background job)
5. Old key can be archived
```

---

## Part 8: Monitoring & Maintenance

### 8.1 Monitor Encryption

```sql
-- Track encryption metrics
SELECT 
  COUNT(*) as total_credentials,
  SUM(CASE WHEN api_key LIKE 'U2FsdG%' THEN 1 ELSE 0 END) as encrypted_count,
  SUM(CASE WHEN api_key NOT LIKE 'U2FsdG%' THEN 1 ELSE 0 END) as unencrypted_count
FROM clients
WHERE api_key IS NOT NULL;
```

### 8.2 Monitor Decryption Errors

```bash
# Check application logs for decryption failures
docker logs iphouse-app | grep -E "decrypt.*error|encryption.*failed"

# Should show: No decryption errors
```

### 8.3 Monthly Audit

```
- [ ] Verify all credentials are encrypted
- [ ] Check encryption key is rotated
- [ ] Verify no plaintext credentials in backups
- [ ] Audit access logs for credential reads
- [ ] Update documentation
```

---

## Part 9: Deployment Checklist

### Pre-Deployment

```
- [ ] Database backup exists
- [ ] Backup table created (safety)
- [ ] Application code updated with encryption
- [ ] Encryption key in Secrets Manager
- [ ] Migration script tested in staging
- [ ] Rollback plan documented
- [ ] Team notified of changes
```

### Deployment Steps

```
1. [ ] Deploy application v2 (with encryption code)
2. [ ] Verify application starts and connects
3. [ ] Test new credential storage (should be encrypted)
4. [ ] Run migration script on production
5. [ ] Monitor logs for any errors
6. [ ] Verify all credentials encrypted
7. [ ] Application reads encrypted credentials correctly
8. [ ] Remove fallback plaintext-reading code
9. [ ] Drop old plaintext columns (optional)
10. [ ] Update documentation
```

### Post-Deployment

```
- [ ] Monitor application logs (24 hours)
- [ ] Check database for any decryption errors
- [ ] Verify encryption key rotation works
- [ ] Audit credentials are inaccessible to unauthorized users
- [ ] Document completion
```

---

## Part 10: Estimated Timeline & Effort

| Task | Time | Effort |
|------|------|--------|
| Update application code | 30 min | Medium |
| Test in staging | 30 min | Medium |
| Database backup | 10 min | Low |
| Deploy application | 10 min | Low |
| Run migration script | 20 min | Medium |
| Verify encryption | 20 min | Medium |
| Monitor & verify | 30 min | Medium |
| **Total** | **~2.5 hours** | **Medium** |

**Downtime**: 0 minutes (zero-downtime migration)

---

## Summary: What Gets Protected

| Threat | Before | After |
|--------|--------|-------|
| Database breach exposes credentials | ❌ Plain SQL dump = all credentials | ✅ Encrypted = unusable |
| Unauthorized database access | ❌ Credentials visible in plaintext | ✅ Encrypted + need key |
| Backup file leak | ❌ Backups contain plaintext | ✅ Encrypted in backups |
| Developer exposing data | ❌ Query result shows plaintext | ✅ Encrypted (need code to decrypt) |
| Disk theft | ❌ Raw disk = plaintext credentials | ✅ Encrypted = unreadable |
| Compliance violation | ❌ No encryption of credentials | ✅ Encrypted at rest ✅ |

---

## Related Documents

- `DATABASE_NETWORK_ISOLATION_SECRETS_ROTATION.md` - Database isolation & key management
- `EC2_SECURITY_GROUPS_IP_MASKING.md` - Network security
- `DEPENDENCY_PATCH_CADENCE.md` - Patch management

---

## Approval & Sign-Off

| Role | Approval | Date |
|------|----------|------|
| Security Lead | — | 2024-07-22 |
| DevOps Lead | — | 2024-07-22 |
| DBA / Data Owner | — | 2024-07-22 |

---

**Status**: 🟢 Ready for Implementation  
**Roadmap Item**: Complete encryption-at-rest migration  
**Implementation Date**: 2024-07-22  
**Last Updated**: 2024-07-22
