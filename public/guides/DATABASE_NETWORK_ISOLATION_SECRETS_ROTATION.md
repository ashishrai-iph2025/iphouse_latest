# Database Network Isolation & Secrets Rotation Guide

**Version**: 1.0  
**Date**: 2024-07-22  
**Roadmap Item**: Network-isolate the database & rotate secrets  
**Status**: Ready for Implementation  
**Environment**: Production (AWS VPC with RDS MySQL)

---

## Overview

This guide provides step-by-step instructions for:

1. **Moving MySQL to a private subnet** with proxy-only access (no internet exposure)
2. **Rotating signing & encryption keys** via AWS Secrets Manager
3. **Implementing automated key rotation** to prevent key compromise

**Key Security Improvements**:
- ✅ Database removed from public internet (private subnet only)
- ✅ Application must authenticate to access database
- ✅ All database traffic encrypted in transit
- ✅ Signing secrets rotated automatically (90 days)
- ✅ Encryption keys rotated automatically (180 days)
- ✅ Audit trail of all key rotations
- ✅ Zero downtime during rotation

---

## Architecture

```
BEFORE (Vulnerable):
┌─────────────────────────────────────────┐
│  EC2 Instance (10.0.1.100)              │
│  ├─ Application (port 8080)             │
│  └─ Secrets in environment variables    │
└─────────────────────────────────────────┘
          ↓
┌─────────────────────────────────────────┐
│  RDS MySQL (public subnet)              │
│  Public endpoint: mysql.xxx.rds.amazonaws.com
│  Accessible from internet ❌             │
└─────────────────────────────────────────┘

AFTER (Hardened):
┌──────────────────────────────────────┐
│  AWS Secrets Manager                 │
│  ├─ JWT_SIGNING_KEY (90-day rotation)│
│  ├─ ENCRYPTION_KEY (180-day rotation)│
│  ├─ DB_PASSWORD (30-day rotation)    │
│  └─ Audit logs: who fetched when     │
└──────────────────────────────────────┘
       ↑ polled by app every 1 hour
       │
┌──────────────────────────────────────┐
│  EC2 Instance (10.0.1.100)           │
│  ├─ Application (port 8080)          │
│  ├─ Fetches secrets from SM          │
│  └─ No secrets stored locally ✅      │
└──────────────────────────────────────┘
       ↓ authenticates with rotated key
       │
┌──────────────────────────────────────┐
│  RDS MySQL (PRIVATE subnet)          │
│  Private endpoint: 10.0.2.50:3306    │
│  Accessible via application only ✅   │
│  Internet unreachable ✅              │
└──────────────────────────────────────┘
```

---

## Prerequisites

Before starting, verify you have:

✅ AWS account with VPC configured  
✅ RDS MySQL instance running  
✅ EC2 instance running application  
✅ Application can be redeployed  
✅ Database backup exists  
✅ List of all secrets in current environment  
✅ IAM permissions to modify RDS, VPC, and Secrets Manager  

**Check**:
```
# From EC2:
mysql -h current-db.region.rds.amazonaws.com -u admin -p
# Expected: MySQL connection succeeds

# Check current secrets:
env | grep -E "JWT|ENCRYPT|DB_"
# Should show environment variables with secrets
```

---

## Part 1: Understanding Database Network Isolation

### 1.1 RDS Network Basics

RDS instances run in AWS VPCs with:
- **Public subnet**: Accessible from internet (bad for databases)
- **Private subnet**: Only accessible from within VPC (good)
- **Security group**: Controls who can connect

### 1.2 Current State (Likely Public)

```
RDS Configuration:
- Publicly accessible: YES ❌
- Subnet: public-subnet-1a
- Security group: sg-0abc123 (allows 0.0.0.0/0 on 3306)
- No encryption in transit
- Static password in environment variables
```

**Problems**:
- Database visible from internet
- Anyone can attempt to brute-force MySQL
- Credentials exposed in EC2 environment
- No key rotation (credentials never change)

### 1.3 Target State (Hardened)

```
RDS Configuration:
- Publicly accessible: NO ✅
- Subnet: private-subnet-1b
- Security group: sg-xxxxx (allows only from EC2)
- SSL/TLS encryption in transit ✅
- Password fetched from Secrets Manager (rotates every 30 days)
- JWT key rotated every 90 days ✅
- Encryption key rotated every 180 days ✅
```

**Benefits**:
- Database completely hidden from internet
- Only application can connect
- Keys rotate automatically without downtime
- Audit trail of all access

---

## Part 2: AWS Secrets Manager Setup

### 2.1 Create Secrets in Secrets Manager

**Navigate to AWS Secrets Manager**:

```
1. AWS Console → Secrets Manager
2. Click "Store a new secret"
```

**Create Secret 1: JWT Signing Key**

```
1. Secret type: "Other type of secret"
2. Key/value:
   Key: "value"
   Value: (leave empty - we'll generate a new key)
3. Or paste current key if rotating existing
4. Secret name: "iphouse/prod/jwt-signing-key"
5. Tags:
   - Service: iphouse
   - Environment: production
   - Rotates: Yes
6. Click "Next"
```

**Create Secret 2: Encryption Key**

```
1. Secret type: "Other type of secret"
2. Key/value:
   Key: "value"
   Value: (leave empty or paste current key)
3. Secret name: "iphouse/prod/encryption-key"
4. Tags:
   - Service: iphouse
   - Environment: production
   - Rotates: Yes
6. Click "Next"
```

**Create Secret 3: Database Password**

```
1. Secret type: "Credentials for RDS database"
2. Credentials:
   Username: admin
   Password: (generate strong 32-char password)
3. Select database: (choose your RDS instance)
4. Secret name: "iphouse/prod/db-password"
5. Tags:
   - Service: iphouse
   - Environment: production
   - Rotates: Yes
6. Click "Next"
```

### 2.2 Generate Strong Keys

For JWT and encryption keys, generate cryptographically secure keys:

```bash
# Generate 32-byte (256-bit) key in base64
openssl rand -base64 32

# Example output:
# aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCDE=

# For JWT (use in Secret 1)
openssl rand -base64 32 > /tmp/jwt_key.txt

# For Encryption (use in Secret 2)
openssl rand -base64 32 > /tmp/encryption_key.txt

# Paste these into Secrets Manager
```

### 2.3 Update RDS Master Password

Once database password is in Secrets Manager, update RDS:

```
1. AWS Console → RDS → Databases
2. Select your MySQL instance
3. Click "Modify"
4. Scroll to "Master password"
5. Uncheck "Apply immediately" to schedule
6. Or check for immediate change (expect brief downtime)
7. Enter new password (from Secrets Manager)
8. Click "Modify DB Instance"
```

---

## Part 3: Move Database to Private Subnet

### 3.1 Create Private Subnet (if not exists)

```
1. AWS Console → VPC → Subnets
2. Click "Create subnet"
3. Configuration:
   VPC: (your VPC)
   Subnet name: private-db-subnet
   Availability Zone: us-east-1b (different from EC2)
   IPv4 CIDR: 10.0.2.0/24
4. Click "Create subnet"
```

### 3.2 Create NAT Gateway (Optional)

If database needs outbound internet (unlikely), create NAT:

```
Skip this unless your database triggers RDS Events
that need to call webhooks
```

### 3.3 Create Database Subnet Group

```
1. AWS Console → RDS → DB subnet groups
2. Click "Create DB subnet group"
3. Configuration:
   Name: private-db-subnet-group
   Description: Private subnet for RDS
   VPC: (your VPC)
   Subnets: Select at least 2 (for Multi-AZ)
     - private-db-subnet (us-east-1b)
     - private-db-subnet-2 (us-east-1c)
4. Click "Create"
```

### 3.4 Modify RDS to Use Private Subnet

```
1. AWS Console → RDS → Databases
2. Select your MySQL instance
3. Click "Modify"
4. Scroll to "Connectivity"
5. DB subnet group: Select "private-db-subnet-group"
6. Public accessibility: Select "No"
7. Check "Apply immediately" (causes brief downtime ~1-2 min)
8. Click "Modify DB Instance"
9. Monitor: RDS will show "Modifying..." status
```

**Wait for RDS to finish modifying** (typically 2-5 minutes).

### 3.5 Verify Private Endpoint

After modification:

```
1. AWS Console → RDS → Databases
2. Select instance
3. In "Connectivity & security" section:
   - Check: "Endpoint" is private IP (10.0.2.50)
   - Check: "Publicly accessible" = No
   - Check: "Subnet" = private-db-subnet-group
```

---

## Part 4: Update Security Groups

### 4.1 Create Database Security Group

```
1. AWS Console → VPC → Security Groups
2. Click "Create security group"
3. Configuration:
   Name: database-security-group
   Description: Restrict MySQL access to application only
   VPC: (your VPC)
4. Click "Create security group"
```

### 4.2 Add Inbound Rule: Application Access

```
1. Select the new security group
2. Click "Edit inbound rules"
3. Click "Add rule"
4. Configuration:
   Type: MySQL/Aurora
   Protocol: TCP
   Port: 3306
   Source: 
     - Type: Security Group
     - Select: app-security-group (your EC2's SG)
5. Click "Save inbound rules"
```

### 4.3 Remove Public Access Rules

```
1. Select the RDS security group (old one)
2. Click "Edit inbound rules"
3. Delete any rules allowing:
   - 0.0.0.0/0 on port 3306
   - ::/0 on port 3306
4. Click "Save inbound rules"
```

### 4.4 Attach New Security Group to RDS

```
1. AWS Console → RDS → Databases
2. Select instance
3. Click "Modify"
4. Scroll to "Security group"
5. Remove old security group (the public one)
6. Add new security group: database-security-group
7. Click "Apply immediately"
8. Click "Modify DB Instance"
```

---

## Part 5: Application Configuration

### 5.1 Update Application to Use Secrets Manager

Modify your Go application to fetch secrets from Secrets Manager instead of environment variables.

**Go Example**:

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/secretsmanager"
)

type DBSecret struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Engine   string `json:"engine"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	DBname   string `json:"dbname"`
}

func getSecret(ctx context.Context, secretName string) (string, error) {
	cfg, err := config.LoadDefaultConfig(ctx)
	if err != nil {
		return "", err
	}
	
	client := secretsmanager.NewFromConfig(cfg)
	result, err := client.GetSecretValue(ctx, &secretsmanager.GetSecretValueInput{
		SecretId: &secretName,
	})
	if err != nil {
		return "", err
	}
	
	return *result.SecretString, nil
}

func getDBSecret(ctx context.Context, secretName string) (*DBSecret, error) {
	secretValue, err := getSecret(ctx, secretName)
	if err != nil {
		return nil, err
	}
	
	var secret DBSecret
	if err := json.Unmarshal([]byte(secretValue), &secret); err != nil {
		return nil, err
	}
	
	return &secret, nil
}

func main() {
	ctx := context.Background()
	
	// Fetch database credentials
	dbSecret, err := getDBSecret(ctx, "iphouse/prod/db-password")
	if err != nil {
		panic(err)
	}
	
	// Fetch JWT signing key
	jwtKey, err := getSecret(ctx, "iphouse/prod/jwt-signing-key")
	if err != nil {
		panic(err)
	}
	
	// Fetch encryption key
	encryptKey, err := getSecret(ctx, "iphouse/prod/encryption-key")
	if err != nil {
		panic(err)
	}
	
	fmt.Printf("DB Host: %s\n", dbSecret.Host)
	fmt.Printf("JWT Key loaded: %d bytes\n", len(jwtKey))
	fmt.Printf("Encryption Key loaded: %d bytes\n", len(encryptKey))
	
	// Initialize database connection
	connectionString := fmt.Sprintf(
		"%s:%s@tcp(%s:%d)/%s",
		dbSecret.Username,
		dbSecret.Password,
		dbSecret.Host,
		dbSecret.Port,
		dbSecret.DBname,
	)
	
	// Connect to database (rest of app)
	_ = connectionString
}
```

### 5.2 Add IAM Role to EC2

EC2 needs permission to read from Secrets Manager:

```
1. AWS Console → IAM → Roles
2. Create or select EC2 instance role
3. Attach policy:
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "secretsmanager:GetSecretValue",
           "secretsmanager:DescribeSecret"
         ],
         "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT-ID:secret:iphouse/prod/*"
       }
     ]
   }
4. Save
```

### 5.3 Remove Environment Variables

**Before**:
```bash
export JWT_SIGNING_KEY="aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890ABCDE="
export ENCRYPTION_KEY="xYz0987654321ABCDEfghIjklMnOpQrStUvWxY="
export DB_PASSWORD="mysql_password_123456"
```

**After**:
```bash
# No secrets in environment!
# Application fetches from Secrets Manager at startup
export AWS_REGION="us-east-1"
```

---

## Part 6: Enable Automatic Key Rotation

### 6.1 Set Up Rotation for DB Password

```
1. AWS Console → Secrets Manager
2. Select "iphouse/prod/db-password"
3. Scroll to "Rotation"
4. Click "Edit rotation"
5. Enable rotation:
   ✓ Enable automatic rotation
6. Rotation rules:
   - Rotate every: 30 days
   - Rotation window: Any day (or pick off-peak)
7. Rotation Lambda function:
   - Create new: SecretsManagerMySQLRotation
8. Click "Save"
```

### 6.2 Set Up Rotation for JWT Key

**Note**: JWT key rotation requires application changes to support old and new keys for a grace period.

```
1. AWS Console → Secrets Manager
2. Select "iphouse/prod/jwt-signing-key"
3. Scroll to "Rotation"
4. Click "Edit rotation"
5. Enable rotation:
   ✓ Enable automatic rotation
6. Rotation rules:
   - Rotate every: 90 days
   - Rotation window: Sunday 2 AM UTC
7. Custom Lambda:
   - You must write this yourself (generates new key)
8. Click "Save"
```

**Custom JWT Rotation Lambda** (Python):

```python
import json
import boto3
import base64
import os
from botocore.exceptions import ClientError

sm_client = boto3.client('secretsmanager')

def lambda_handler(event, context):
    """
    Rotate JWT signing key
    """
    service_client_id = event['ClientRequestToken']
    secret_id = event['SecretId']
    
    try:
        # Get current secret
        current = sm_client.get_secret_value(
            SecretId=secret_id,
            VersionId=service_client_id,
            VersionStage='AWSCURRENT'
        )
        current_secret = current['SecretString']
        
        # Generate new key
        import secrets
        new_key = base64.b64encode(secrets.token_bytes(32)).decode('utf-8')
        
        # Update secret with new version
        sm_client.put_secret_value(
            SecretId=secret_id,
            ClientRequestToken=service_client_id,
            Secret=new_key,
            VersionStages=['AWSPENDING']
        )
        
        # Finalize rotation
        sm_client.update_secret_version_stage(
            SecretId=secret_id,
            VersionStage='AWSCURRENT',
            MoveToVersionId=service_client_id,
            RemoveFromVersionId=current['VersionId']
        )
        
        print(f"Successfully rotated JWT key")
        return {'statusCode': 200}
        
    except ClientError as e:
        raise e
```

### 6.3 Set Up Rotation for Encryption Key

Similar to JWT, encryption key rotation requires a grace period where both old and new keys are accepted:

```
1. AWS Console → Secrets Manager
2. Select "iphouse/prod/encryption-key"
3. Rotation: Enable every 180 days
4. Custom Lambda: Deploy custom rotation function
```

---

## Part 7: Testing

### 7.1 Test Private Subnet Connection

From EC2, verify connection to private RDS:

```bash
# SSH into EC2
ssh -i key.pem ec2-user@EC2_IP

# Get the RDS private endpoint
# From Secrets Manager or AWS console

# Try to connect
mysql -h private-rds-endpoint.region.rds.amazonaws.com \
      -u admin -p

# Expected: MySQL connection succeeds
```

### 7.2 Test Secrets Manager Access

```bash
# SSH into EC2

# Verify IAM role allows Secrets Manager access
aws secretsmanager get-secret-value \
  --secret-id iphouse/prod/db-password \
  --region us-east-1

# Expected: Returns secret (password, username, host, etc.)
```

### 7.3 Test Application Startup

Restart your application:

```bash
# It should fetch secrets from Secrets Manager
# Check logs:

docker logs app-container 2>&1 | grep -E "Connecting|Secret|Database"

# Expected: "Successfully connected to database"
# NOT: "Reading from environment variables"
```

### 7.4 Test Internet Isolation

Try to reach database from internet (should fail):

```bash
# From outside AWS (your laptop):
mysql -h private-rds-endpoint.xxx.rds.amazonaws.com \
      -u admin -p

# Expected: Connection timeout (database is private)
```

### 7.5 Test Key Rotation Doesn't Break App

Manually trigger a rotation:

```bash
# AWS Console → Secrets Manager
# Select "iphouse/prod/jwt-signing-key"
# Click "Rotate secret" → "Rotate now"

# Monitor application logs
docker logs -f app-container

# Expected: Application continues working
# No "invalid token" errors
# (because app should read new key from Secrets Manager)
```

---

## Part 8: Troubleshooting

### Issue 1: "Access Denied" to Secrets Manager

**Symptoms**: Application can't fetch secrets

**Solution**:
```
1. Check EC2 IAM role has Secrets Manager permissions
2. Verify role is attached to EC2 instance
3. Check policy allows "secretsmanager:GetSecretValue"
4. Check secret ARN in policy matches actual secret
```

### Issue 2: "Connection refused" to database

**Symptoms**: Application can't connect to RDS

**Solution**:
```
1. Verify RDS is in private subnet (not public)
2. Check security group allows EC2's security group on port 3306
3. Verify RDS endpoint in secret matches current endpoint
4. Verify password in Secrets Manager hasn't changed unexpectedly
5. Check EC2 can reach RDS:
   telnet private-rds-endpoint.xxx.rds.amazonaws.com 3306
```

### Issue 3: Key Rotation Breaks Application

**Symptoms**: Tokens fail verification after rotation

**Solution**:
```
1. Application should support old and new keys temporarily
2. Implement grace period (e.g., accept old key for 24 hours)
3. Fetch key from Secrets Manager on every startup (not cached)
4. Test rotation in staging before production
5. Monitor JWT error logs during and after rotation
```

### Issue 4: Rotation Lambda Fails

**Symptoms**: "Rotation failed" in Secrets Manager

**Solution**:
```
1. Check Lambda execution role has permissions
2. Check Lambda timeout is long enough (default 30s)
3. Check Lambda logs in CloudWatch
4. Verify RDS security group allows Lambda to connect
5. Test Lambda manually in AWS Console
```

---

## Part 9: Monitoring & Maintenance

### 9.1 Monitor Rotation Status

```
1. AWS Console → Secrets Manager
2. Select each secret
3. Check "Last rotation" timestamp
4. Verify rotation succeeds every N days
5. Set up CloudWatch alarm if rotation fails
```

### 9.2 Audit Secret Access

```
1. AWS Console → CloudTrail
2. Filter by:
   - Service: secretsmanager
   - Event: GetSecretValue
3. View:
   - Which app/instance accessed secret
   - When it was accessed
   - From which IP
```

### 9.3 Monitor Database Connections

```
1. AWS Console → RDS → Performance Insights
2. Monitor:
   - Connection count (should be stable)
   - Query performance
   - Replication lag (if Multi-AZ)
3. Alert if:
   - Connection count spikes
   - Authentication failures increase
```

### 9.4 Monthly Rotation Check

```
- [ ] Verify all secrets rotated successfully
- [ ] Check CloudTrail logs for access patterns
- [ ] Test manual rotation still works
- [ ] Review application logs for key-related errors
- [ ] Update documentation if new secrets added
```

---

## Part 10: Deployment Checklist

### Pre-Deployment

```
- [ ] Backup current RDS database
- [ ] Document current secrets and their values
- [ ] Generate new JWT and encryption keys
- [ ] Create AWS Secrets Manager secrets
- [ ] Update RDS master password
- [ ] Create private subnets and security groups
- [ ] Update application code to use Secrets Manager
- [ ] Add IAM permissions to EC2 role
- [ ] Test in staging environment
```

### Deployment Steps

```
1. [ ] Backup database
2. [ ] Create Secrets Manager secrets with current values
3. [ ] Add IAM permissions to EC2
4. [ ] Update application code (use Secrets Manager)
5. [ ] Modify RDS:
   - Change to private subnet
   - Update security groups
   - Update master password
   - Update SSL/TLS settings
6. [ ] Redeploy application
7. [ ] Verify application connects to private RDS
8. [ ] Remove old environment variables from EC2
9. [ ] Enable automatic key rotation
10. [ ] Monitor logs for errors
```

### Post-Deployment

```
- [ ] Verify application connects via Secrets Manager
- [ ] Verify RDS is in private subnet
- [ ] Verify direct internet access to RDS fails
- [ ] Verify automatic rotation works
- [ ] Monitor first 24 hours of logs
- [ ] Document new architecture
- [ ] Update runbooks with new procedures
```

---

## Part 11: Estimated Timeline & Effort

| Task | Time | Effort |
|------|------|--------|
| Create Secrets Manager secrets | 10 min | Low |
| Generate new keys | 5 min | Trivial |
| Create VPC infrastructure | 10 min | Low |
| Modify RDS (private subnet) | 10 min | Low |
| Update security groups | 10 min | Low |
| Update application code | 30 min | Medium |
| Test in staging | 20 min | Medium |
| Enable rotation | 10 min | Low |
| Deploy to production | 15 min | Medium |
| Monitor and verify | 20 min | Medium |
| **Total** | **~2 hours** | **Medium** |

**Total Implementation Time**: 2 hours of active work + 30-60 min monitoring

**Downtime**: ~2-5 minutes (RDS subnet migration)

---

## Summary: What Gets Protected

| Threat | Before | After |
|--------|--------|-------|
| Database exposed online | ❌ Public endpoint | ✅ Private only |
| Brute-force database | ❌ Reachable from internet | ✅ Only from app |
| Credential theft | ❌ In environment variables | ✅ Secrets Manager |
| Outdated credentials | ❌ Never change | ✅ Auto-rotated (30 days) |
| Key compromise | ❌ No rotation plan | ✅ Rotated (90/180 days) |
| Audit trail missing | ❌ No logging | ✅ CloudTrail logs all access |
| Zero-day in app | ❌ Database fully exposed | ✅ Compartmentalized access |

---

## Related Documents

- `EC2_SECURITY_GROUPS_IP_MASKING.md` - EC2 firewall rules
- `CLOUDFLARE_WAF_BOT_PROTECTION.md` - Edge protection
- `ENCRYPTION_AT_REST.md` - Data encryption
- AWS Secrets Manager: https://docs.aws.amazon.com/secretsmanager/

---

## Approval & Sign-Off

| Role | Approval | Date |
|------|----------|------|
| DevOps Lead | — | 2024-07-22 |
| Security Lead | — | 2024-07-22 |
| DBA / Data Owner | — | 2024-07-22 |

---

**Status**: 🟢 Ready for Implementation  
**Roadmap Item**: Network-isolate the database & rotate secrets  
**Implementation Date**: 2024-07-22  
**Last Updated**: 2024-07-22
