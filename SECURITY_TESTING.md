# Security Testing Guide for IPHouse

This guide walks you through testing all the security implementations added to the IPHouse application.

## Quick Start

### Option 1: Bash Script (Fastest)
```bash
cd d:\VM\iphouse_Latest

# Make script executable
chmod +x scripts/test-security.sh

# Run tests against production
./scripts/test-security.sh

# Run against staging
TEST_DOMAIN=staging.markscan.co.in ./scripts/test-security.sh

# Use HTTP instead of HTTPS
PROTOCOL=http ./scripts/test-security.sh
```

### Option 2: Node.js Script
```bash
cd d:\VM\iphouse_Latest

# Run tests
npm run security:test:prod

# Or manually
npx ts-node scripts/test-security.ts
```

### Option 3: Manual cURL Testing
```bash
# Test all headers at once
curl -I https://reports.markscan.co.in

# Expected output (should see all these):
# X-Frame-Options: DENY
# X-Content-Type-Options: nosniff
# X-XSS-Protection: 1; mode=block
# Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
# Content-Security-Policy: default-src 'self'; ...
# Referrer-Policy: strict-origin-when-cross-origin
# Permissions-Policy: camera=(), microphone=(), ...
```

---

## 1️⃣ Security Headers Test

### Automated Test
```bash
./scripts/test-security.sh
```

### Manual Test
```bash
# Get all response headers
curl -I https://reports.markscan.co.in

# Check specific header
curl -I https://reports.markscan.co.in | grep "X-Frame-Options"
# Expected: X-Frame-Options: DENY
```

### What Each Header Prevents

| Header | Prevents | Example Attack |
|--------|----------|---|
| **X-Frame-Options: DENY** | Clickjacking | Site embedded in iframe |
| **X-Content-Type-Options: nosniff** | MIME sniffing | Browser guessing file type |
| **X-XSS-Protection** | Reflected XSS | `<script>alert('xss')</script>` |
| **Strict-Transport-Security** | SSL stripping | MITM forcing HTTP |
| **Content-Security-Policy** | Inline script execution | Injected malicious scripts |
| **Referrer-Policy** | Data leakage | Tracking user navigation |
| **Permissions-Policy** | API abuse | Accessing camera/microphone |

---

## 2️⃣ Input Validation Test

### Browser-Based Test (Interactive)

1. **SQL Injection Test**
   ```
   Open: https://reports.markscan.co.in/login
   Username: admin' OR '1'='1
   Password: test
   Expected: "Username contains suspicious characters" error
   ```

2. **XSS Test**
   ```
   Username: <script>alert('xss')</script>
   Password: test
   Expected: "Username contains suspicious characters" error
   ```

3. **Min Length Test**
   ```
   Username: ab (only 2 chars)
   Password: test
   Expected: "Username must be at least 3 characters" error
   ```

4. **Max Length Test**
   ```
   Username: aaaaaa...aaaaaa (> 100 chars)
   Expected: "Username must be less than 100 characters" error
   ```

5. **Invalid Character Test**
   ```
   Username: user@#$%
   Password: test
   Expected: "Username can only contain letters, numbers, dots..." error
   ```

### Automated Test (Console)
```javascript
// Open browser console (F12) and run:
import { validateLoginForm, detectSuspiciousInput } from '@/lib/validation'

// Test SQL injection detection
detectSuspiciousInput("admin' OR '1'='1")  // true
detectSuspiciousInput("DROP TABLE users")  // true
detectSuspiciousInput("normalusername")    // false

// Test validation
validateLoginForm("admin", "pass")
// {valid: false, errors: ["Username must be at least 3 characters", ...]}

validateLoginForm("admin123", "validpass") 
// {valid: true, errors: []}
```

---

## 3️⃣ Rate Limiting Test

### Browser-Based Test (Manual)

1. **Check Rate Limit Storage**
   ```
   Open: https://reports.markscan.co.in/login
   Press F12 → Application → LocalStorage
   Look for: rate_limit_login_<username>
   ```

2. **Trigger Rate Limit**
   ```
   1. Try login with "testuser" / "wrong" 5 times quickly
   2. On 5th attempt: See "Too many attempts. Try again in 15 minutes."
   3. Check localStorage: Should show locked: true, lockedUntil: <timestamp>
   4. Attempting 6th time: "Account locked for 15 minutes" error
   ```

3. **Rate Limit Config**
   ```
   Maximum attempts: 5
   Time window: 5 minutes
   Lockout duration: 15 minutes
   ```

### Automated Test Script (JavaScript)
```javascript
// Open browser console and run:
import { recordAttempt, clearRateLimit } from '@/lib/rateLimit'

// Simulate 5 failed attempts
for (let i = 0; i < 5; i++) {
  const result = recordAttempt('login', 'testuser')
  console.log(`Attempt ${i+1}:`, result.message)
}

// Expected output:
// Attempt 1: 4 attempts remaining
// Attempt 2: 3 attempts remaining
// Attempt 3: 2 attempts remaining
// Attempt 4: 1 attempts remaining
// Attempt 5: Last attempt

// 6th attempt
const result = recordAttempt('login', 'testuser')
console.log(result.message) // "Too many attempts. Account locked for 15 minutes."
console.log(result.allowed) // false

// Clear rate limit (on successful login)
clearRateLimit('login', 'testuser')
```

---

## 4️⃣ HTTPS & SSL Test

### Bash Command
```bash
# Check if HTTPS works
curl -I https://reports.markscan.co.in
# Should return HTTP 200

# Check certificate validity
echo | openssl s_client -servername reports.markscan.co.in \
  -connect reports.markscan.co.in:443 2>/dev/null | \
  openssl x509 -noout -dates
# Should show "notAfter" date in future
```

### Online Tools
- **SSL Labs**: https://www.ssllabs.com/ssltest/analyze.html?d=reports.markscan.co.in
  - Should get A or A+ rating
- **Security Headers**: https://securityheaders.com/?q=reports.markscan.co.in
  - Should get A or B rating

---

## 5️⃣ CSP (Content Security Policy) Test

### Browser Console Test
```javascript
// Open browser DevTools → Console

// Test 1: Inline script should be blocked (depending on CSP config)
eval('console.log("This might be blocked by CSP")')

// Test 2: Script from same-origin should work
// Go to a page that loads a script from your domain - should work

// Test 3: Script from random CDN should be blocked (if not whitelisted)
// Try to dynamically load:
const s = document.createElement('script')
s.src = 'https://random-cdn-not-in-csp.com/script.js'
document.body.appendChild(s)
// Should see CSP violation in console
```

### Check CSP Header
```bash
curl -I https://reports.markscan.co.in | grep "Content-Security-Policy"

# Should see something like:
# Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; ...
```

---

## 6️⃣ Login Flow End-to-End Test

### Success Path
1. Go to: https://reports.markscan.co.in/login
2. Enter valid credentials
3. Click Sign In
4. Expected: 
   - No validation errors shown
   - Rate limit key cleared from localStorage
   - Redirected to dashboard or OTP page
   - Session created successfully

### Failure Path (Invalid Input)
1. Go to: https://reports.markscan.co.in/login
2. Username: `admin' OR '1'='1`
3. Password: `test`
4. Click Sign In
5. Expected:
   - Error shown: "Username contains suspicious characters"
   - No API call made
   - Stay on login page

### Rate Limit Path
1. Go to: https://reports.markscan.co.in/login
2. Try login 5 times with valid format but wrong credentials
3. On 6th attempt:
   - Expected: "Too many attempts. Try again in 15 minutes."
   - Cannot submit form
   - localStorage shows lockout

---

## 7️⃣ Docker Build Security Test

### Scan Docker Image
```bash
# Build the Docker image
docker build -t iphouse:latest .

# Scan for vulnerabilities
docker scan iphouse:latest

# Expected: Should show any critical/high vulnerabilities
# Fix: Update base image version in Dockerfile
```

### Image Security Checklist
- [ ] Base image is from official repository (node:xx-alpine)
- [ ] Base image version is latest LTS
- [ ] No secrets in image (check .dockerignore)
- [ ] Non-root user preferred (check Dockerfile)
- [ ] Image scanned for vulnerabilities

---

## 📊 Automated Test Suites

### Run All Tests Together
```bash
# Bash script (fastest)
./scripts/test-security.sh

# Node.js script (more detailed)
npm run security:test:prod
```

### Expected Output (Bash)
```
================================
IPHouse Security Test Suite
================================
Domain: reports.markscan.co.in
Protocol: https

TEST 1: Connection Test
----------------------
✓ Server responding (HTTP 200)

TEST 2: Security Headers
------------------------
✓ X-Frame-Options
✓ X-Content-Type-Options
✓ X-XSS-Protection
✓ Strict-Transport-Security (HSTS)
✓ Content-Security-Policy
✓ Referrer-Policy

TEST 3: HTTPS Configuration
----------------------------
✓ HTTPS connection successful

TEST 4: HTTP to HTTPS Redirect
-------------------------------
✓ HTTP redirects to HTTPS (status: 200)

TEST 5: SSL Certificate
-----------------------
Valid until: Aug 22 16:00:00 2024 GMT
✓ SSL certificate valid

================================
SUMMARY
================================
Passed: 11/11 (100%)

✅ All security tests passed!
```

---

## 🐛 Troubleshooting

### Test Fails: "Cannot reach domain"
```bash
# Check if domain is accessible
ping reports.markscan.co.in

# Check if EC2 instance is running
aws ec2 describe-instances --filters "Name=tag:Name,Values=iphouse"

# Check security groups allow inbound 443
aws ec2 describe-security-groups --group-ids sg-xxxxx
```

### Test Fails: "Header missing"
```bash
# Check if middleware.ts is loaded
# Verify: middleware.ts exists in root directory

# Rebuild and restart
npm run build
docker build -t iphouse:latest .
docker-compose down && docker-compose up
```

### Test Fails: "HTTPS connection error"
```bash
# Check SSL certificate
openssl s_client -connect reports.markscan.co.in:443

# Check Cloudflare SSL settings
# Dashboard → SSL/TLS → should be "Full (strict)"

# Check if certificate is valid
echo | openssl s_client -servername reports.markscan.co.in \
  -connect reports.markscan.co.in:443 2>/dev/null | \
  openssl x509 -noout -text | grep -A2 "Validity"
```

### Rate Limiting Not Working
```bash
# Check localStorage is available
# In browser console:
typeof localStorage
// Should return "object", not "undefined"

# Check rate limit key exists
Object.keys(localStorage).filter(k => k.includes('rate_limit'))

# Clear and test again
localStorage.clear()
// Then retry login 5 times
```

---

## ✅ Verification Checklist

Use this checklist before deploying to production:

### Application Layer
- [ ] Security headers middleware is in place (`middleware.ts`)
- [ ] Input validation library is working (`lib/validation.ts`)
- [ ] Rate limiting is active (`lib/rateLimit.ts`)
- [ ] Login form uses validation + rate limiting
- [ ] All security header tests pass (A/B grade on securityheaders.com)
- [ ] No console errors on login page
- [ ] SQL injection test returns validation error
- [ ] XSS test returns validation error
- [ ] Rate limiting triggers after 5 attempts

### Infrastructure
- [ ] HTTPS is enabled and working
- [ ] SSL certificate is valid (not expired)
- [ ] HTTP redirects to HTTPS
- [ ] EC2 security groups whitelist only Cloudflare IPs
- [ ] Docker image scanned for vulnerabilities
- [ ] Production domain accessible

### Cloudflare
- [ ] WAF rules are enabled
- [ ] Bot management is active
- [ ] Rate limiting rules configured
- [ ] SSL mode set to "Full (strict)"
- [ ] Always Use HTTPS is enabled
- [ ] Origin IP masking verified

---

## 📚 References

### Security Standards
- **OWASP Top 10**: https://owasp.org/www-project-top-ten/
- **Security Headers**: https://securityheaders.com/
- **Mozilla Security**: https://infosec.mozilla.org/guidelines/web_security

### Testing Tools
- **SSL Labs**: https://www.ssllabs.com/ssltest/
- **Security Headers Scanner**: https://securityheaders.com/
- **OWASP ZAP**: https://www.zaproxy.org/
- **Burp Suite**: https://portswigger.net/burp

### Cloudflare Docs
- **WAF Rules**: https://developers.cloudflare.com/waf/
- **SSL/TLS**: https://developers.cloudflare.com/ssl/
- **Rate Limiting**: https://developers.cloudflare.com/rate-limiting/

---

## 💬 Need Help?

If a test fails:
1. Check the error message carefully
2. Read the troubleshooting section above
3. Review the SECURITY_AUDIT.md for implementation details
4. Check server logs: `docker logs <container-id>`
5. Verify Cloudflare dashboard settings
6. Test with curl before using browsers

---

**Last Updated**: 2024-07-22
**Status**: All security implementations complete ✅
