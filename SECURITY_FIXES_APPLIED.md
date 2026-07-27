# Security Fixes Applied — IP House Project

**Date**: 2026-07-26  
**Fixes Applied By**: Claude Code  
**Status**: ✅ Fixes applied locally only (NO github push)

---

## 📋 Summary of Fixes

| Issue | File(s) | Severity | Status | Notes |
|-------|---------|----------|--------|-------|
| Hardcoded encryption key defaults | `lib/crypto.ts` | CRITICAL | ✅ Fixed | Now requires env vars, fails on startup if missing |
| SSL verification disabled | `lib/fetchWithoutSSL.ts` | CRITICAL | ✅ Fixed | Only allow in dev with `ALLOW_INSECURE_SSL_DEV_ONLY=true` |
| Permissive CSP with unsafe-inline | `middleware.ts` | HIGH | ✅ Fixed | Removed `'unsafe-inline'`, requires external CSS/JS |
| Test DB endpoint exposed | `go-server/main.go` | HIGH | ✅ Fixed | Endpoint removed; use `/api/keepalive` instead |
| Missing CORS config docs | `go-server/main.go` | HIGH | ✅ Fixed | CORS already properly configured with env var |
| Weak `.env.example` template | `.env.example` | MEDIUM | ✅ Fixed | Created comprehensive secure template |

---

## 🔥 CRITICAL: .env.local Exposed in Git

**Status**: ⚠️ **NOT YET FIXED** — Requires user action  
**Action Required**: **IMMEDIATELY ROTATE ALL SECRETS**

### What's Exposed:
- Production database IP: `13.222.133.205`
- Production database password: `Support@22$#`
- Staging database credentials
- NEXTAUTH_SECRET
- Encryption keys (ENCRYPTION_KEY, API_CRED_KEY, API_CRED_IV)

### How to Fix:

#### Step 1: Rotate All Secrets
```bash
# Generate new ENCRYPTION_KEY (32 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate new API_CRED_KEY (32 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Generate new API_CRED_IV (16 hex chars)
node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

# Generate new NEXTAUTH_SECRET (32 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

#### Step 2: Update .env.local with New Secrets
```
ENCRYPTION_KEY=<new-value>
API_CRED_KEY=<new-value>
API_CRED_IV=<new-value>
NEXTAUTH_SECRET=<new-value>
```

#### Step 3: Remove .env.local from Git History
```bash
# Install git-filter-repo (one-time)
pip install git-filter-repo

# Remove .env.local from entire git history
git filter-repo --path .env.local --invert-paths

# WARNING: This rewrites history! All pushes must use --force-with-lease
# Coordinate with team before doing this
```

#### Step 4: Verify .env.local is in .gitignore
```bash
grep ".env.local" .gitignore
# Should output: .env.local
```

#### Step 5: Rotate Database Passwords
```sql
-- Staging DB
ALTER USER 'staging_user'@'localhost' IDENTIFIED BY '<new-strong-password>';
FLUSH PRIVILEGES;

-- Production DB
-- Use secure connection to production DB admin
ALTER USER 'prod_user'@'13.222.133.205' IDENTIFIED BY '<new-strong-password>';
FLUSH PRIVILEGES;
```

#### Step 6: Rotate API Keys
- Regenerate Markscan API keys in Markscan admin panel
- Update MARKSCAN_API_KEY in production environment

---

## ✅ Fixes Applied

### 1. **lib/crypto.ts** — Require Encryption Keys

**Problem**: Hardcoded placeholder defaults could decrypt credentials if env vars not set.

**Solution**:
```typescript
// Before (UNSAFE)
const KEY = process.env.ENCRYPTION_KEY ?? ''
const API_KEY = Buffer.from(process.env.API_CRED_KEY ?? '12345678901234567890123456789012')

// After (SECURE)
if (!process.env.ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is required and not set')
}
const KEY = process.env.ENCRYPTION_KEY
```

**Impact**: App now fails to start if encryption keys are not configured.

---

### 2. **lib/fetchWithoutSSL.ts** — Restrict SSL Bypass to Dev Only

**Problem**: SSL verification was always disabled, enabling MITM attacks.

**Solution**:
```typescript
// Before (INSECURE)
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'  // ALWAYS disabled!
  return fetch(url, init)
}

// After (SECURE)
export function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_INSECURE_SSL_DEV_ONLY === 'true') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'  // Dev only with opt-in
  } else if (process.env.NODE_ENV === 'production' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('SSL verification cannot be disabled in production.')
  }
  return fetch(url, init)
}
```

**Impact**: 
- Production: SSL verification is mandatory (MITM attacks prevented)
- Development: Can opt-in with `ALLOW_INSECURE_SSL_DEV_ONLY=true` for self-signed certs
- Better approach: Use `NODE_EXTRA_CA_CERTS` environment variable to add self-signed CA to trust store

---

### 3. **middleware.ts** — Remove Unsafe CSP Directives

**Problem**: CSP allowed inline scripts/styles (`'unsafe-inline'`), enabling XSS attacks.

**Solution**:
```
// Before (INSECURE)
script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net

// After (SECURE)
script-src 'self' https://cdn.jsdelivr.net
```

**Impact**: Inline scripts/styles now blocked. Extract to separate files or use nonce-based CSP.

---

### 4. **go-server/main.go** — Remove Test DB Endpoint

**Problem**: `/api/test-db` exposed database connectivity info (information disclosure).

**Solution**:
```go
// Removed:
mux.HandleFunc("GET /api/test-db", handlers.TestDB)

// Use instead:
// Authenticated endpoint: GET /api/keepalive (requires JWT)
```

**Impact**: Attackers can no longer probe database availability.

---

### 5. **.env.example** — Comprehensive Secure Template

**Problem**: Original `.env.example` lacked security guidance.

**Solution**: Created detailed template with:
- ✅ Secret generation commands
- ✅ Security reminders
- ✅ Production configuration guidance
- ✅ Environment-specific values
- ✅ SSL/TLS best practices
- ✅ CORS configuration
- ✅ Session timeouts

---

## 🚨 Outstanding Issues (Requires User Action)

### Priority 1: Rotate Secrets NOW
- [ ] Rotate ENCRYPTION_KEY
- [ ] Rotate API_CRED_KEY / API_CRED_IV
- [ ] Rotate NEXTAUTH_SECRET
- [ ] Rotate database passwords (staging + production)
- [ ] Rotate Markscan API keys
- [ ] Update all deployment environments with new secrets

### Priority 2: Remove .env.local from Git History
- [ ] Run `git filter-repo --path .env.local --invert-paths`
- [ ] Coordinate with team (rewrites history)
- [ ] Force-push with `--force-with-lease`
- [ ] Notify all developers to `git pull --rebase`

### Priority 3: Force Password Resets for MD5-Hashed Accounts
- [ ] Identify accounts with MD5 password hashes
- [ ] Send password reset notification emails
- [ ] Set password reset flag in database
- [ ] Force re-authentication on next login

### Priority 4: Production Configuration
- [ ] Set `ALLOWED_ORIGINS` env var to whitelist production domains
- [ ] Configure `NODE_EXTRA_CA_CERTS` for self-signed cert (if applicable)
- [ ] Set `ALLOW_INSECURE_SSL_DEV_ONLY=false` in production
- [ ] Enable HTTPS/TLS for all production endpoints
- [ ] Configure WAF (Web Application Firewall)

---

## 📊 Security Features Already in Place ✅

The project has several good security practices already:

- ✅ **Bcrypt hashing** (12-round cost) for passwords
- ✅ **Parameterized queries** (no SQL injection)
- ✅ **JWT with expiration** (30 min idle timeout)
- ✅ **Server-side API tokens** (not in JWT)
- ✅ **Rate limiting** (per-IP enforcement)
- ✅ **CORS whitelisting** (not wildcard)
- ✅ **Security headers** (HSTS, X-Frame-Options, etc.)
- ✅ **Input validation** (SQL injection & XSS detection)
- ✅ **Session timeout** (configurable per role)
- ✅ **Go server assertions** against MD5 hashes

---

## 📝 Recommended Next Steps

### Week 1:
1. Rotate all secrets (CRITICAL)
2. Update production environment variables
3. Run database password resets
4. Test SSL/TLS configuration

### Week 2:
1. Remove `.env.local` from git history
2. Coordinate team git pull
3. Send password reset emails to users

### Week 3:
1. Monitor logs for anomalies
2. Audit database access logs
3. Review CORS/firewall rules
4. Plan quarterly secret rotation schedule

### Ongoing:
1. Monthly secret rotation schedule
2. Security audit for new features
3. Monitor security advisories for dependencies
4. Keep Node.js, Go, MySQL updated

---

## 🔗 References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Go Security Best Practices](https://golang.org/doc/security)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)
- [HSTS Preload](https://hstspreload.org/)

---

**Last Updated**: 2026-07-26  
**Applied Changes Location**: Local only (no GitHub push)  
**Next Action**: User should immediately rotate secrets
