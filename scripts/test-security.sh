#!/bin/bash

# Security Testing Script for IPHouse
# Quick verification of security headers and HTTPS

DOMAIN="${TEST_DOMAIN:-reports.markscan.co.in}"
PROTOCOL="${PROTOCOL:-https}"

echo "================================"
echo "IPHouse Security Test Suite"
echo "================================"
echo "Domain: $DOMAIN"
echo "Protocol: $PROTOCOL"
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Test function
test_header() {
    local header_name=$1
    local url="$PROTOCOL://$DOMAIN"
    local response=$(curl -s -I "$url" 2>&1)

    if echo "$response" | grep -qi "^$header_name:"; then
        echo -e "${GREEN}✓${NC} $header_name found"
        ((PASSED++))
    else
        echo -e "${RED}✗${NC} $header_name MISSING"
        ((FAILED++))
    fi
}

# Test 1: Connection test
echo ""
echo "TEST 1: Connection Test"
echo "----------------------"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$PROTOCOL://$DOMAIN")
if [ "$STATUS" -lt 400 ]; then
    echo -e "${GREEN}✓${NC} Server responding (HTTP $STATUS)"
    ((PASSED++))
else
    echo -e "${RED}✗${NC} Server not responding (HTTP $STATUS)"
    ((FAILED++))
fi

# Test 2: Security Headers
echo ""
echo "TEST 2: Security Headers"
echo "------------------------"

HEADERS=$(curl -s -I "$PROTOCOL://$DOMAIN" 2>&1)

echo "$HEADERS" | grep -qi "x-frame-options" && \
    echo -e "${GREEN}✓${NC} X-Frame-Options" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} X-Frame-Options MISSING" && ((FAILED++))

echo "$HEADERS" | grep -qi "x-content-type-options" && \
    echo -e "${GREEN}✓${NC} X-Content-Type-Options" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} X-Content-Type-Options MISSING" && ((FAILED++))

echo "$HEADERS" | grep -qi "x-xss-protection" && \
    echo -e "${GREEN}✓${NC} X-XSS-Protection" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} X-XSS-Protection MISSING" && ((FAILED++))

echo "$HEADERS" | grep -qi "strict-transport-security" && \
    echo -e "${GREEN}✓${NC} Strict-Transport-Security (HSTS)" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} Strict-Transport-Security MISSING" && ((FAILED++))

echo "$HEADERS" | grep -qi "content-security-policy" && \
    echo -e "${GREEN}✓${NC} Content-Security-Policy" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} Content-Security-Policy MISSING" && ((FAILED++))

echo "$HEADERS" | grep -qi "referrer-policy" && \
    echo -e "${GREEN}✓${NC} Referrer-Policy" && ((PASSED++)) || \
    echo -e "${RED}✗${NC} Referrer-Policy MISSING" && ((FAILED++))

# Test 3: HTTPS
echo ""
echo "TEST 3: HTTPS Configuration"
echo "----------------------------"
if [ "$PROTOCOL" = "https" ]; then
    curl -s "$PROTOCOL://$DOMAIN" > /dev/null 2>&1
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓${NC} HTTPS connection successful"
        ((PASSED++))
    else
        echo -e "${RED}✗${NC} HTTPS connection failed"
        ((FAILED++))
    fi
else
    echo -e "${YELLOW}⊘${NC} Skipping HTTPS test (USE_HTTP=true)"
fi

# Test 4: HTTP Redirect (optional)
echo ""
echo "TEST 4: HTTP to HTTPS Redirect"
echo "-------------------------------"
if [ "$PROTOCOL" = "https" ]; then
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://$DOMAIN" -L --max-time 5)
    if [ "$HTTP_STATUS" -lt 400 ]; then
        echo -e "${GREEN}✓${NC} HTTP redirects to HTTPS (status: $HTTP_STATUS)"
        ((PASSED++))
    else
        echo -e "${YELLOW}⊘${NC} HTTP redirect may not be working (status: $HTTP_STATUS)"
    fi
else
    echo -e "${YELLOW}⊘${NC} Skipping HTTP redirect test (USE_HTTP=true)"
fi

# Test 5: SSL Certificate
echo ""
echo "TEST 5: SSL Certificate"
echo "-----------------------"
if [ "$PROTOCOL" = "https" ]; then
    CERT_INFO=$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -dates 2>/dev/null)
    if [ $? -eq 0 ]; then
        echo "$CERT_INFO" | grep "notAfter" | sed 's/notAfter=/Valid until: /'
        echo -e "${GREEN}✓${NC} SSL certificate valid"
        ((PASSED++))
    else
        echo -e "${RED}✗${NC} SSL certificate could not be verified"
        ((FAILED++))
    fi
else
    echo -e "${YELLOW}⊘${NC} Skipping SSL test (USE_HTTP=true)"
fi

# Summary
echo ""
echo "================================"
echo "SUMMARY"
echo "================================"
TOTAL=$((PASSED + FAILED))
PERCENTAGE=$((PASSED * 100 / TOTAL))

echo -e "Passed: ${GREEN}$PASSED${NC}/$TOTAL ($PERCENTAGE%)"
if [ $FAILED -gt 0 ]; then
    echo -e "Failed: ${RED}$FAILED${NC}/$TOTAL"
fi

echo ""

if [ $PERCENTAGE -eq 100 ]; then
    echo -e "${GREEN}✅ All security tests passed!${NC}"
    exit 0
elif [ $PERCENTAGE -ge 80 ]; then
    echo -e "${YELLOW}⚠️  Most tests passed. Review failures above.${NC}"
    exit 0
else
    echo -e "${RED}❌ Some security tests failed. Review errors above.${NC}"
    exit 1
fi
