package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/ip-house/iphouse-api/config"
	"golang.org/x/crypto/bcrypt"
)

// Claims stored in the JWT cookie.
type Claims struct {
	LoginID        int64   `json:"loginId"`
	UserID         int64   `json:"userId"`
	Role           *int64  `json:"role"`
	LoginType      int64   `json:"loginType"`
	LoginUsername  string  `json:"loginUsername"`
	LoginFirstName string  `json:"loginFirstName"`
	LoginLastName  string  `json:"loginLastName"`
	ClientName     string  `json:"clientName"`
	// APIToken is intentionally NOT stored in the JWT. A JWT is only signed, not
	// encrypted — embedding the Markscan bearer token there exposed it to anyone
	// who could read the cookie value. The token is now held server-side (in-memory
	// cache) and re-derived from the client's stored credentials on a cache miss.
	APIAccess bool `json:"apiAccess"` // true when a Markscan token was obtained → full data access
	// Impersonation: when an Admin/Super Admin is viewing the platform AS a
	// client, these carry the original staff identity so the session can be
	// restored on exit. Zero/empty on a normal session.
	ImpersonatorLoginID int64  `json:"impLoginId,omitempty"`
	ImpersonatorEmail   string `json:"impEmail,omitempty"`
	ImpersonatorName    string `json:"impName,omitempty"`
	ImpersonatorRole    int64  `json:"impRole,omitempty"`
	jwt.RegisteredClaims
}

// IsLegacyHash reports whether a stored password is a legacy 32-char MD5 hash
// (as opposed to a modern bcrypt hash). Used to transparently upgrade hashes
// to bcrypt on successful login.
func IsLegacyHash(stored string) bool {
	return len(stored) == 32
}

func SignToken(claims Claims) (string, error) {
	claims.RegisteredClaims = jwt.RegisteredClaims{
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Duration(config.C.SessionIdleSeconds) * time.Second)),
		IssuedAt:  jwt.NewNumericDate(time.Now()),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString([]byte(config.C.JWTSecret))
}

func ParseToken(tokenStr string) (*Claims, error) {
	t, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method")
		}
		return []byte(config.C.JWTSecret), nil
	})
	if err != nil {
		return nil, err
	}
	if c, ok := t.Claims.(*Claims); ok && t.Valid {
		return c, nil
	}
	return nil, fmt.Errorf("invalid token")
}

// VerifyPassword checks bcrypt or legacy MD5.
func VerifyPassword(input, stored string) bool {
	if len(stored) == 32 {
		h := md5.Sum([]byte(input))
		return fmt.Sprintf("%x", h) == stored
	}
	return bcrypt.CompareHashAndPassword([]byte(stored), []byte(input)) == nil
}

func HashPassword(plain string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(plain), 12)
	return string(h), err
}

// ── Encryption matching PHP/TS crypto ────────────────────────────────────────

// EncryptMain encrypts a value with the main ENCRYPTION_KEY.
// Format: base64(rawIV[16] + base64CipherBytes) — mirrors the TS encrypt().
func EncryptMain(plain string) string {
	key := []byte(config.C.EncryptionKey)
	if len(key) == 0 || plain == "" {
		return plain
	}
	iv := make([]byte, 16)
	if _, err := rand.Read(iv); err != nil {
		return plain
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return plain
	}
	padded := pkcs7Pad([]byte(plain), aes.BlockSize)
	cipherBytes := make([]byte, len(padded))
	mode := cipher.NewCBCEncrypter(block, iv)
	mode.CryptBlocks(cipherBytes, padded)
	b64cipher := base64.StdEncoding.EncodeToString(cipherBytes)
	combined := append(iv, []byte(b64cipher)...)
	return base64.StdEncoding.EncodeToString(combined)
}

// DecryptMain decrypts values encrypted with the main ENCRYPTION_KEY.
// Format: base64(rawIV[16] + base64CipherBytes)
func DecryptMain(encoded string) string {
	key := []byte(config.C.EncryptionKey)
	if len(key) == 0 {
		return encoded
	}
	combined, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(combined) < 16 {
		return encoded
	}
	iv := combined[:16]
	b64cipher := string(combined[16:])
	cipherBytes, err := base64.StdEncoding.DecodeString(b64cipher)
	if err != nil {
		return encoded
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return encoded
	}
	if len(cipherBytes)%aes.BlockSize != 0 {
		return encoded
	}
	mode := cipher.NewCBCDecrypter(block, iv)
	mode.CryptBlocks(cipherBytes, cipherBytes)
	return string(pkcs7Unpad(cipherBytes))
}

// DecryptAPIPassword decrypts values stored with fixed API_CRED_KEY/IV.
func DecryptAPIPassword(encoded string) string {
	key := []byte(config.C.APICredKey)
	iv := []byte(config.C.APICredIV)
	if len(key) < 32 || len(iv) < 16 {
		return encoded
	}
	cipherBytes, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return encoded
	}
	block, err := aes.NewCipher(key[:32])
	if err != nil {
		return encoded
	}
	if len(cipherBytes) == 0 || len(cipherBytes)%aes.BlockSize != 0 {
		return encoded
	}
	mode := cipher.NewCBCDecrypter(block, iv[:16])
	mode.CryptBlocks(cipherBytes, cipherBytes)
	return string(pkcs7Unpad(cipherBytes))
}

func pkcs7Pad(b []byte, blockSize int) []byte {
	pad := blockSize - len(b)%blockSize
	for i := 0; i < pad; i++ {
		b = append(b, byte(pad))
	}
	return b
}

func pkcs7Unpad(b []byte) []byte {
	if len(b) == 0 {
		return b
	}
	pad := int(b[len(b)-1])
	if pad == 0 || pad > aes.BlockSize {
		return b
	}
	return b[:len(b)-pad]
}
