package handlers

import "testing"

// The 6-digit login code is only 1e6 wide, so VerifyOTP must burn it after a
// small number of wrong guesses. These cover the counter that enforces that.
func TestOTPAttemptCap(t *testing.T) {
	const uid int64 = 4242
	clearOTPAttempts(uid)
	defer clearOTPAttempts(uid)

	if otpAttemptsExceeded(uid) {
		t.Fatal("a user with no failures must not be locked out")
	}

	// The first maxOTPAttempts-1 wrong guesses leave budget remaining.
	for i := 1; i < maxOTPAttempts; i++ {
		left := registerOTPFailure(uid)
		if left != maxOTPAttempts-i {
			t.Fatalf("after %d failures: got %d attempts left, want %d", i, left, maxOTPAttempts-i)
		}
		if otpAttemptsExceeded(uid) {
			t.Fatalf("locked out too early, after only %d failures", i)
		}
	}

	// The final wrong guess exhausts the budget and trips the lockout.
	if left := registerOTPFailure(uid); left != 0 {
		t.Fatalf("final failure: got %d attempts left, want 0", left)
	}
	if !otpAttemptsExceeded(uid) {
		t.Fatalf("must be locked out after %d failures", maxOTPAttempts)
	}
}

// Issuing a fresh code (SendOTP) resets the budget, so a legitimate user who
// mistyped is not permanently locked out.
func TestOTPAttemptsResetOnNewCode(t *testing.T) {
	const uid int64 = 4343
	clearOTPAttempts(uid)
	defer clearOTPAttempts(uid)

	for i := 0; i < maxOTPAttempts; i++ {
		registerOTPFailure(uid)
	}
	if !otpAttemptsExceeded(uid) {
		t.Fatal("precondition: user should be locked out")
	}

	clearOTPAttempts(uid) // what SendOTP / a successful verify does
	if otpAttemptsExceeded(uid) {
		t.Fatal("a newly issued code must start with a clean attempt budget")
	}
}

// Counters must not bleed across users — one account's failures cannot lock out
// another.
func TestOTPAttemptsArePerUser(t *testing.T) {
	const victim, attacker int64 = 5151, 5252
	clearOTPAttempts(victim)
	clearOTPAttempts(attacker)
	defer clearOTPAttempts(victim)
	defer clearOTPAttempts(attacker)

	for i := 0; i < maxOTPAttempts; i++ {
		registerOTPFailure(attacker)
	}
	if !otpAttemptsExceeded(attacker) {
		t.Fatal("attacker should be locked out")
	}
	if otpAttemptsExceeded(victim) {
		t.Fatal("an unrelated user must not be locked out by someone else's failures")
	}
}
