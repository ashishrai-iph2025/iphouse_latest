# Cloudflare WAF & Bot Protection Configuration Guide

**Version**: 1.0  
**Date**: 2024-07-22  
**Roadmap Item**: Cloudflare WAF rules & bot protection  
**Status**: Ready for Implementation  
**Environment**: Production (EC2 behind Cloudflare proxy)

---

## Overview

This guide provides step-by-step instructions for configuring Cloudflare's Web Application Firewall (WAF) and Bot Management to protect the IPHouse platform from common attacks, malicious bots, and DDoS attempts.

**Key Protection Layers**:
- ✅ Application layer (code): Validation, rate limiting, security headers (DONE)
- ✅ Database layer (code): Authorization, encryption (DONE)
- ⏳ Edge layer (Cloudflare): WAF, bot protection, DDoS mitigation (THIS GUIDE)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Users/Attackers                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│            CLOUDFLARE EDGE (Global Network)                 │
├──────────────────────────────────────────────────────────────┤
│  1. DDoS Protection (always on)                              │
│  2. WAF Rules (managed + custom)                             │
│  3. Bot Detection & Challenge                                │
│  4. Rate Limiting (edge level)                               │
│  5. Country/IP Blocking                                      │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       │ Filtered traffic only
                       │
┌──────────────────────▼──────────────────────────────────────┐
│              YOUR EC2 INSTANCE (Production)                  │
├──────────────────────────────────────────────────────────────┤
│  1. Security Headers (middleware)                            │
│  2. Input Validation (lib/validation.ts)                     │
│  3. Rate Limiting (lib/rateLimit.ts)                         │
│  4. Authorization (handlers)                                 │
│  5. Database Protection (migrations)                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

Before starting, verify you have:

✅ Domain registered and pointing to Cloudflare nameservers  
✅ Cloudflare account with appropriate plan (Pro or Business recommended for WAF)  
✅ Domain DNS records configured in Cloudflare  
✅ EC2 instance running with security groups configured  
✅ SSL/TLS certificate installed (Cloudflare provides free certificate)

**Check**: Go to https://dash.cloudflare.com/ and verify your domain is active

---

## Part 1: Cloudflare Account Setup

### 1.1 Verify Nameserver Configuration

```
1. Go to Cloudflare Dashboard → Your Domain
2. Check: SSL/TLS status should be "Active"
3. Check: DNS tab shows all your domain records
4. Check: Caching rules are configured
```

### 1.2 Verify SSL/TLS

```
1. Dashboard → SSL/TLS
2. Verify mode is "Full" or "Full (Strict)"
   - Recommended: "Full (Strict)" for encryption end-to-end
3. Check: Your EC2 certificate is valid
4. Edge Certificates: Should show "Authoritative"
```

### 1.3 Enable Always Use HTTPS

```
1. Dashboard → Security → HTTPS
2. Toggle: "Always Use HTTPS" = ON
3. This forces all traffic to HTTPS
```

---

## Part 2: DDoS Protection (Baseline)

Cloudflare's DDoS protection is **enabled by default** for all domains. Verify it's active:

### 2.1 Check DDoS Settings

```
1. Dashboard → Security → DDoS
2. Verify: "DDoS Protection" is enabled
3. Sensitivity: Set to "High" (recommended for admin panels)
   - Low: Fewer false positives, less protection
   - High: More aggressive blocking
4. Click "Save"
```

### 2.2 Enable Advanced DDoS Protection (if available on plan)

For Business/Enterprise plans:
```
1. Dashboard → Security → DDoS
2. Advanced DDoS settings may include:
   - Anomaly detection sensitivity
   - Geographic restrictions
   - Protocol attack detection
```

---

## Part 3: WAF Rules Configuration

### 3.1 Enable Cloudflare Managed Ruleset (Critical)

The managed ruleset includes rules for:
- SQL injection protection
- XSS attack prevention
- Known exploits and vulnerabilities
- Protocol attacks

**Steps**:

```
1. Dashboard → Security → WAF
2. Click "Managed Rules" tab
3. Under "Cloudflare Managed Ruleset":
   - Click "Deploy" or "Enable"
4. Configuration options:
   - Mode: "Block" (recommended for production)
   - Sensitivity: "Normal"
5. Click "Save"
```

### 3.2 Configure Ruleset Sensitivity

```
1. Dashboard → Security → WAF → Managed Rules
2. Find "Cloudflare Managed Ruleset"
3. Click on it to configure
4. Sensitivity level:
   - Low: 5% false positives, less comprehensive
   - Medium: 1% false positives, balanced
   - High: 0.1% false positives, very strict
5. Recommended: Start with "Medium", monitor for false positives
6. If admin users get blocked: Lower sensitivity or whitelist
```

### 3.3 Enable OWASP ModSecurity Core Ruleset

This is a battle-tested set of rules for web vulnerabilities:

```
1. Dashboard → Security → WAF → Managed Rules
2. Find "Cloudflare OWASP ModSecurity Core Ruleset"
3. Click "Enable" or "Deploy"
4. Settings:
   - Mode: "Block"
   - Paranoia level: "1" (standard, recommended)
5. Save
```

**What it protects against**:
- SQL Injection
- Local File Inclusion (LFI)
- Remote Code Execution (RCE)
- Cross-Site Scripting (XSS)
- Cross-Site Request Forgery (CSRF)

### 3.4 Enable Additional Rulesets

```
1. Dashboard → Security → WAF → Managed Rules
2. Enable these additional rulesets:
   ✓ Cloudflare Exposed Credentials Check
   ✓ Cloudflare API Abuse Prevention
   ✓ Cloudflare Advanced DDOS
3. For each: Set Mode = "Block", Save
```

---

## Part 4: Custom WAF Rules

Beyond managed rulesets, create custom rules for your specific threats:

### 4.1 Create Rule: Block SQL Injection Patterns

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Block SQL Injection - Admin Panel"
4. Rules:
   Expression: (cf.uri_path contains "/admin") and (http.request.uri.query contains "union" or http.request.uri.query contains "select" or http.request.uri.query contains "drop")
   Action: Block
5. Priority: 1
6. Save
```

### 4.2 Create Rule: Block Suspicious User Agents

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Block Known Bot User Agents"
4. Rules:
   Expression: (http.user_agent contains "sqlmap") or (http.user_agent contains "nikto") or (http.user_agent contains "masscan")
   Action: Block (or Challenge for less aggressive)
5. Priority: 2
6. Save
```

### 4.3 Create Rule: Whitelist Admin IPs (if static)

If your admin team works from fixed IPs:

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Whitelist Internal Admin IPs"
4. Rules:
   Expression: (cf.ip in {1.2.3.4 2.3.4.5 3.4.5.6})
   Action: Allow (bypass all other rules)
5. Priority: 0 (highest priority)
6. Save
```

This ensures admins are never blocked by WAF.

### 4.4 Create Rule: Rate Limiting at Cloudflare Level

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Rate Limit - Login Endpoint"
4. Rules:
   Expression: (http.request.uri.path contains "/api/auth/login")
   Action: Challenge (or Rate Limit if available on plan)
   Threshold: 10 requests per 10 minutes
5. Save
```

**This complements your code-level rate limiting**:
- Code-level: Per-user, per-session (client-side + server-side)
- Cloudflare-level: Per-IP, global (catches botnet attacks)

---

## Part 5: Bot Management

### 5.1 Enable Bot Fight Mode (Free/Pro Plans)

Available on Free, Pro, and Business plans:

```
1. Dashboard → Security → Bots
2. Toggle: "Bot Fight Mode" = ON
3. This enables:
   - Automated bot detection
   - Challenge for suspicious bots
   - Logging of bot requests
4. Save
```

**What it blocks**:
- Credential stuffing bots
- Vulnerability scanners
- Scrapers (that look like bots)

**What it allows**:
- Search engine bots (Google, Bing)
- Monitoring bots (Pingdom, DataDog)
- CDN verification bots

### 5.2 Configure Bot Fight Mode Settings

```
1. Dashboard → Security → Bots → Bot Fight Mode
2. Options:
   a) "Block": Automatically block known bots
   b) "Challenge": Show CAPTCHA to suspicious traffic
   c) "Definitely Automated": Only block clearly automated traffic
   
3. Recommended for production:
   - Set to "Challenge" for suspicious traffic
   - Set to "Block" for known malicious bots
4. Save
```

### 5.3 Enable Super Bot Fight Mode (Business/Enterprise)

If you have Business plan or higher, enable advanced bot protection:

```
1. Dashboard → Security → Bots → Super Bot Fight Mode
2. Features:
   - ML-powered bot detection
   - Behavioral analysis
   - Advanced credential stuffing protection
3. Configure:
   - Definitely Automated: Block
   - Likely Automated: Challenge
   - Verified Bots: Allow (Google, Bing, etc.)
4. Save
```

### 5.4 Create Whitelist for Legitimate Bots

Some automated tools you may need to whitelist:

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Allow Monitoring & Analytics Bots"
4. Rules:
   Expression: (http.user_agent contains "DataDog") or (http.user_agent contains "Pingdom") or (http.user_agent contains "UptimeRobot")
   Action: Allow (bypass bot checks)
5. Priority: 1
6. Save
```

---

## Part 6: Rate Limiting (Edge Level)

Cloudflare's edge-level rate limiting complements your application-level rate limiting:

### 6.1 Create Rate Limiting Rule - Login Endpoint

```
1. Dashboard → Security → WAF → Rate Limiting Rules
2. Click "Create Rate Limiting Rule"
3. Configuration:
   Name: "Rate Limit - Login (5/min per IP)"
   Expression: (http.request.uri.path == "/api/auth/login")
   Threshold: 5 requests
   Period: 60 seconds
   Action: Block (or Challenge)
   Duration: 15 minutes
4. Save
```

### 6.2 Create Rate Limiting Rule - API Endpoints

```
1. Dashboard → Security → WAF → Rate Limiting Rules
2. Click "Create Rate Limiting Rule"
3. Configuration:
   Name: "Rate Limit - All API (100/min per IP)"
   Expression: (http.request.uri.path contains "/api")
   Threshold: 100 requests
   Period: 60 seconds
   Action: Challenge
   Duration: 10 minutes
4. Save
```

### 6.3 Create Rate Limiting Rule - Admin Panel

```
1. Dashboard → Security → WAF → Rate Limiting Rules
2. Click "Create Rate Limiting Rule"
3. Configuration:
   Name: "Rate Limit - Admin (50/min per IP)"
   Expression: (http.request.uri.path contains "/admin")
   Threshold: 50 requests
   Period: 60 seconds
   Action: Block
   Duration: 30 minutes
4. Save
```

**Rate Limiting Strategy**:
- **Strict** (5-10/min): For auth endpoints, admin panels
- **Normal** (50-100/min): For API endpoints
- **Loose** (1000+/min): For static assets, public pages

---

## Part 7: Geographic Restrictions (Optional)

If your users are in specific regions, block others:

### 7.1 Enable Country Blocking

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Block High-Risk Countries"
4. Rules:
   Expression: (ip.geoip.country in {"KP" "IR" "SY"})
   Action: Block
5. Save
```

**Common country codes**:
- US = United States
- GB = United Kingdom
- DE = Germany
- KP = North Korea
- IR = Iran
- SY = Syria

### 7.2 Allowlist Specific Countries (Reverse Approach)

Alternative: Only allow traffic from specific countries:

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Only Allow Authorized Countries"
4. Rules:
   Expression: (ip.geoip.country not in {"US" "GB" "DE" "CA" "AU"})
   Action: Block
5. Save
```

---

## Part 8: Request Size & Protocol Protection

### 8.1 Enable Protocol Attack Protection

```
1. Dashboard → Security → DDoS
2. Under "Protocol Attacks":
   - Enable: "UDP Flood Protection"
   - Enable: "SYN Flood Protection"
   - Enable: "DNS Amplification Protection"
3. Save
```

### 8.2 Configure Request Size Limits

```
1. Dashboard → Security → WAF → Custom Rules
2. Click "Create Rule"
3. Rule Name: "Block Oversized Requests"
4. Rules:
   Expression: (http.request.body.size > 10485760)  # 10MB limit
   Action: Block
5. Save
```

---

## Part 9: Monitoring & Logging

### 9.1 Enable Detailed Logging

```
1. Dashboard → Security → WAF
2. Click "Logging" tab
3. Enable: "Extended WAF Logging" (if available on plan)
4. This logs:
   - Blocked requests
   - Challenged requests
   - WAF rule that was triggered
   - IP, user agent, path, timestamp
```

### 9.2 View WAF Activity

```
1. Dashboard → Security → WAF → Activity Log
2. Filter by:
   - Action (Blocked, Challenged, Allowed)
   - Rule name
   - Country, IP address
   - Date range
3. Review false positives and adjust rules
```

### 9.3 Create Alert for WAF Blocks

```
1. Dashboard → Notifications → Create Alert
2. Alert Name: "WAF Block Spike"
3. Condition:
   - When WAF blocks spike above normal
   - Notification method: Email
4. Save
```

### 9.4 Monitor Bot Traffic

```
1. Dashboard → Analytics & Reporting → Security
2. View:
   - Bot traffic percentage
   - Blocked bot requests
   - Bot challenges issued
3. If legitimate bots are being blocked: Whitelist them
```

---

## Part 10: Testing & Validation

### 10.1 Test WAF Rules Are Active

#### Test SQL Injection Detection

```bash
# This should be blocked
curl "https://yourdomain.com/api/search?q=union+select+1,2,3"

# Expected response: 403 Forbidden or 429 Too Many Requests
# Indicates: WAF rule triggered
```

#### Test XSS Detection

```bash
# This should be blocked
curl "https://yourdomain.com/api/search?q=<script>alert('xss')</script>"

# Expected response: 403 Forbidden
```

#### Test Rate Limiting

```bash
# Run 10 requests rapidly
for i in {1..10}; do
  curl "https://yourdomain.com/api/auth/login" -X POST -d '{"username":"test"}'
done

# Expected response after 5th request: 429 Too Many Requests
```

### 10.2 Verify Bot Blocking

```bash
# Simulate a bot user agent
curl "https://yourdomain.com/" -H "User-Agent: sqlmap/1.0"

# Expected response: 403 Forbidden or CAPTCHA challenge
```

### 10.3 Test Whitelisted IPs

If you configured IP whitelisting:

```bash
# From whitelisted IP
curl "https://yourdomain.com/admin" --interface 1.2.3.4

# Expected: Full access, no blocks
```

### 10.4 Load Testing with Legitimate Traffic

```bash
# Use Apache Bench to simulate legitimate users
ab -n 100 -c 10 "https://yourdomain.com/"

# Monitor WAF logs - should NOT be blocked
```

---

## Part 11: Troubleshooting

### Issue 1: Legitimate Users Getting Blocked

**Symptoms**: Admin users or internal tools report "403 Forbidden"

**Solution**:
```
1. Check WAF Activity Log for the IP/user
2. See which rule triggered the block
3. Options:
   a) Whitelist the IP (create custom rule with Allow)
   b) Adjust rule sensitivity (lower it)
   c) Disable specific rule if it's too aggressive
4. Test again
```

### Issue 2: Rate Limiting Too Aggressive

**Symptoms**: Legitimate users can't make more than a few requests

**Solution**:
```
1. Dashboard → Security → WAF → Rate Limiting Rules
2. Increase threshold:
   - Change "5 requests per minute" → "20 requests per minute"
   - Or change "per IP" to "per IP + user"
3. Test with legitimate traffic
4. Monitor false positives
```

### Issue 3: Bots Not Being Blocked

**Symptoms**: Scrapers/malicious bots still accessing your site

**Solution**:
```
1. Check Bot Fight Mode is enabled
2. Review bot activity in Analytics
3. Create custom rule to block specific user agents
4. Enable rate limiting at application level (already done)
5. Check origin server is rejecting unauthorized access
```

### Issue 4: Performance Degradation

**Symptoms**: Site is slower after enabling WAF

**Solution**:
```
1. This is rare - Cloudflare WAF runs at the edge (no impact on origin)
2. If slow: Check if you have too many custom rules
3. Monitor database performance (code-level changes)
4. Check if rule expressions are inefficient
```

---

## Part 12: Security Rules Checklist

Create a summary of all your active rules:

### Managed Rulesets (Enabled)
- [ ] Cloudflare Managed Ruleset
- [ ] OWASP ModSecurity Core Ruleset
- [ ] Exposed Credentials Check
- [ ] API Abuse Prevention
- [ ] Advanced DDoS

### Custom Rules (Create)
- [ ] Block SQL Injection patterns
- [ ] Block Suspicious User Agents
- [ ] Whitelist Admin IPs (if applicable)
- [ ] Rate Limit Login Endpoint (5/min)
- [ ] Rate Limit API Endpoints (100/min)
- [ ] Rate Limit Admin Panel (50/min)

### Bot Protection (Enabled)
- [ ] Bot Fight Mode (minimum) or Super Bot Fight Mode (if available)
- [ ] Whitelist Legitimate Bots

### DDoS Protection (Enabled)
- [ ] DDoS Protection = High sensitivity
- [ ] Protocol Attack Protection = Enabled

### SSL/TLS (Enabled)
- [ ] Always Use HTTPS = ON
- [ ] SSL/TLS Mode = Full (Strict)

### Monitoring (Enabled)
- [ ] WAF Activity Logging
- [ ] Security Alerts
- [ ] Analytics dashboard

---

## Part 13: Production Deployment Checklist

### Pre-Deployment (Staging)

```
1. Enable WAF rules on staging domain
2. Run full test suite
3. Test login, API calls, admin panel
4. Monitor for false positives (24 hours)
5. Review WAF logs for legitimate blocks
6. Whitelist any false positives
7. Verify performance is normal
8. Get team approval
```

### Deployment Steps (Production)

```
1. Dashboard → Your Domain → Security
2. Enable each ruleset one at a time (with testing between)
3. Step 1: Enable Cloudflare Managed Ruleset
   - Wait 1 hour, monitor logs
   - Check for false positives
4. Step 2: Enable OWASP Ruleset
   - Wait 1 hour, monitor logs
5. Step 3: Enable Bot Fight Mode
   - Wait 1 hour, monitor logs
6. Step 4: Enable Rate Limiting Rules
   - Wait 1 hour, monitor logs
7. Step 5: Enable Custom Rules
   - Deploy one rule at a time
   - Monitor logs after each
```

### Post-Deployment (Production)

```
1. Monitor WAF Activity Log for 24 hours
2. Alert threshold: If >5% of requests blocked, investigate
3. Check user reports of access issues
4. Review bot traffic patterns
5. Verify performance metrics are normal
6. Document any false positives
7. Create tickets to whitelist legitimate IPs/bots
8. Celebrate! 🎉 WAF is now protecting your production
```

---

## Part 14: Maintenance & Updates

### Weekly Tasks

```
- [ ] Review WAF Activity Log
- [ ] Check for new false positives
- [ ] Whitelist any legitimate IPs that were blocked
- [ ] Monitor bot traffic patterns
```

### Monthly Tasks

```
- [ ] Review security alerts
- [ ] Check Cloudflare's rule updates (they release new rules)
- [ ] Update rate limiting thresholds if needed
- [ ] Test critical flows (login, API calls, admin panel)
```

### Quarterly Tasks

```
- [ ] Full WAF audit
- [ ] Review all custom rules for effectiveness
- [ ] Test disaster recovery (what if WAF is down?)
- [ ] Update documentation
- [ ] Security training for team on new threats
```

---

## Part 15: Integration with Application Security

Your application already has these protections ✅

```
┌─────────────────────────────────────────────────────┐
│ CLOUDFLARE LEVEL (This Guide - Now Implementing)    │
├─────────────────────────────────────────────────────┤
│ • WAF rules (SQL injection, XSS)                    │
│ • Bot detection & challenges                        │
│ • Rate limiting (per IP)                            │
│ • DDoS protection                                   │
├─────────────────────────────────────────────────────┤
│ APPLICATION LEVEL (Already Done ✅)                 │
├─────────────────────────────────────────────────────┤
│ • Input validation (lib/validation.ts)              │
│ • Client-side rate limiting (lib/rateLimit.ts)     │
│ • Security headers (middleware.ts)                  │
│ • Authorization checks (handlers/misc.go)           │
│ • Password hashing (go-server/auth)                 │
│ • Database audit trail (migrations)                 │
└─────────────────────────────────────────────────────┘
```

**Defense in Depth**: Multiple layers means if one fails, others catch the attack.

---

## Part 16: Estimated Timeline & Effort

| Task | Time | Effort |
|------|------|--------|
| Enable DDoS protection | 5 min | Trivial |
| Enable Cloudflare Managed Ruleset | 5 min | Trivial |
| Enable Bot Fight Mode | 5 min | Trivial |
| Create 3-5 custom rules | 30 min | Low |
| Test all rules | 30 min | Medium |
| Monitor for 24 hours | — | Async |
| **Total** | **~1 hour** | **Low** |

**Total Implementation Time**: 1-2 hours of active work + 24-48 hours monitoring

---

## Summary: What Gets Protected

| Attack Type | Protection Layer | How |
|---|---|---|
| SQL Injection | Cloudflare WAF + Code validation | Rule blocks, input validation rejects |
| XSS | Cloudflare WAF + Security headers | Rule blocks, CSP header blocks |
| Bot Attack | Bot Fight Mode | Challenge issued, slowing attack |
| Brute Force Login | Cloudflare Rate Limit + Code rate limit | IP rate limited, session rate limited |
| DDoS | Cloudflare DDoS + Rate limiting | Absorbed at edge, doesn't reach origin |
| Credential Stuffing | Bot detection + Rate limiting | Bots challenged, rapid logins blocked |
| Malware/Exploit | OWASP ruleset + Security scanning | Known exploits blocked at edge |

---

## Next Steps

1. **This Week**: 
   - Enable Cloudflare Managed Ruleset
   - Enable Bot Fight Mode
   - Enable DDoS protection (High sensitivity)
   
2. **Next Week**:
   - Create 5 custom rules (SQL injection, rate limiting, etc.)
   - Test all rules thoroughly
   - Monitor WAF logs
   
3. **Ongoing**:
   - Review WAF logs weekly
   - Whitelist false positives
   - Update rules based on new threats

---

## Useful Links

- Cloudflare Dashboard: https://dash.cloudflare.com/
- WAF Rule Documentation: https://developers.cloudflare.com/waf/
- Bot Management Docs: https://developers.cloudflare.com/bots/
- Rate Limiting Docs: https://developers.cloudflare.com/waf/rate-limiting-rules/

---

## Related Documents

- `SECURITY_AUDIT.md` - Complete security review
- `DEPENDENCY_PATCH_CADENCE.md` - Dependency management
- `EC2_SECURITY_GROUPS_SETUP.md` - Network security
- `middleware.ts` - Application security headers
- `lib/validation.ts` - Input validation
- `lib/rateLimit.ts` - Application rate limiting

---

## Approval & Sign-Off

| Role | Approval | Date |
|------|----------|------|
| Security Lead | — | 2024-07-22 |
| DevOps Lead | — | 2024-07-22 |
| Tech Lead | — | 2024-07-22 |

---

**Status**: 🟢 Ready for Implementation  
**Roadmap Item**: Cloudflare WAF rules & bot protection  
**Implementation Date**: 2024-07-22  
**Last Updated**: 2024-07-22
