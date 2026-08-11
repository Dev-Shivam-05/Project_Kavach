// ═══════════════════════════════════════════════════════════════════════════════
// FCM HTTP v1 — the leg that makes a closed phone ring (W10 · 1.35 · F-21)
//
// ★ WHY THIS FILE EXISTS ★
// Until it did, a family phone learned about an incident only while its
// WebSocket was alive. App closed, socket dropped, screen off at 3 a.m. — the
// incident reached the server correctly, escalated correctly, and nobody's phone
// rang. The only working leg to another human was SMS. This is the file that
// changes that, and it is the top of Phase 1's dependency chain for exactly that
// reason: everything else in the phase is downstream of a phone ringing.
//
// ★ DATA-ONLY, ALWAYS — F-21 ★
// Every message built here carries `data` and NEVER `notification`. Two reasons,
// and the second is the load-bearing one:
//
//  1. A `notification` block is rendered by the OS. The text would be composed
//     HERE, on the server, in a payload that transits Google and lands on a
//     locked screen. F-21 says the human-readable string is born on the device,
//     from group-decrypted state (mobile/src/state/notifications.ts is where).
//  2. A `notification` block does not wake a killed app's handler. Data-only is
//     what reaches expo-notifications' background task, which is what lets the
//     device compose and present the alert itself.
//
// The payload is the lock-screen-safe set and nothing else: incidentId,
// familyId, trigger, tier, subjectShortName, and — since W10-d · 1.32 — kind and
// ownerShortName, which are what a CLAIM broadcast is made of (§2.6.4; see
// pushPayload for why the five could not carry one). `assertPushSafe` enforces
// that as a fail-closed assertion rather than a code-review convention, because — F-01 —
// the duress bit must not be inferable from anything that leaves the device, and
// a push payload is a side channel like any other. A frame that acquired a
// forbidden key is not degraded, it is a privacy breach, and dropping it is
// correct.
//
// ★ WHY IT IS HAND-ROLLED ★
// backend/go.mod has zero `require` lines and ADR-002 keeps it that way, so
// google.golang.org/api is not available. What that library does for this call
// is three things — sign an RS256 JWT, trade it for an access token, POST JSON —
// and all three are stdlib. crypto/rsa signs, crypto/x509 parses the PKCS#8 key
// out of the service-account file, net/http does the rest.
//
// ★ NOT CONFIGURED IS A FIRST-CLASS STATE ★
// There are no FCM credentials in this deployment. New() therefore returns
// (nil, ErrPushNotConfigured) rather than panicking or half-initialising, and
// fan-out records KV-NOPUSHCFG against every device it could not reach. A push
// leg that quietly reports success it cannot vouch for would corrupt the four
// clocks and the notification matrix, which are the only evidence the family has
// that the chain works (§2.6.1, §16.2).
// ═══════════════════════════════════════════════════════════════════════════════
package notify

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	sm "github.com/kavach/backend/internal/incident"
)

// EnvFCMCredentials names the path to a Google service-account JSON key with the
// Firebase Cloud Messaging API enabled. Unset is the normal state today.
const EnvFCMCredentials = "KAVACH_FCM_CREDENTIALS"

var (
	// ErrPushNotConfigured is not a failure. It is the truthful answer to "can
	// this deployment ring a closed phone", and the delivery matrix prints it.
	ErrPushNotConfigured = errors.New("notify: no FCM credentials configured")

	// ErrPushUnregistered is FCM saying the token is dead: the app was
	// uninstalled, its data cleared, or the token rolled. T-218 requires the
	// device be marked degraded and the family alerted — a family member whose
	// phone can no longer be reached must find out from us, not from an
	// emergency.
	ErrPushUnregistered = errors.New("notify: FCM token is no longer registered")

	// ErrPushRejected is a message FCM refused. Retrying it unchanged will fail
	// identically, so the ladder must move on rather than burn the incident's
	// seconds on it.
	ErrPushRejected = errors.New("notify: FCM rejected the message")
)

// PushSender is the consumer-defined slice of "can send a push" that fan-out
// needs (§2.5.3). Fan-out depends on this, never on *FCMClient, so the delivery
// path is testable without a network and a different provider is a constructor
// change rather than a rewrite.
type PushSender interface {
	Send(ctx context.Context, token string, data map[string]string) error
}

// ── the payload contract (F-21) ──────────────────────────────────────────────

// pushSafeKeys is the complete set a data-only push may carry. An allowlist, not
// a deny-list: a deny-list is wrong the moment somebody adds a field, and the
// field that gets added is always the interesting one.
var pushSafeKeys = map[string]bool{
	"incidentId": true, "familyId": true, "trigger": true,
	"tier": true, "subjectShortName": true,
	// W10-d · 1.32. `kind` is a three-valued enum and `ownerShortName` is the
	// same ASCII short name as the subject's, already permitted above.
	"kind": true, "ownerShortName": true,
}

// assertPushSafe fails closed. Note what is not on the list and would be caught
// here: `duress` (F-01), `sealed`, `lat`/`lon` (I-3), the note, the medical card.
func assertPushSafe(data map[string]string) error {
	for k := range data {
		if !pushSafeKeys[k] {
			return fmt.Errorf("notify: %q is not permitted in a push payload (F-21)", k)
		}
	}
	return nil
}

// pushTTL is how long FCM should keep trying before it discards the message.
//
// The default is four weeks, which for an emergency is actively wrong: a phone
// that comes back online on Tuesday would ring, at full alarm volume, for an
// incident that resolved on Saturday. That is not a late alert, it is a false
// one, and it spends the family's trust in the alarm — the scarcest resource in
// the product (RISK-002).
//
// The horizon is therefore the AUTO_QUIESCE timer read straight off the
// generated machine: past it the incident is DORMANT by definition and the alert
// has nothing left to say. Read rather than hardcoded so that changing
// spec/state-machine.yaml changes this too — a duplicated 21600 here is exactly
// the drift the codegen exists to prevent.
func pushTTL() time.Duration {
	for _, tr := range sm.Transitions {
		if tr.On == sm.EventAutoQuiesce && tr.AfterS > 0 {
			return time.Duration(tr.AfterS) * time.Second
		}
	}
	// The machine has no AUTO_QUIESCE transition at all. Rather than invent a
	// horizon, fall back to the tightest one the ladder knows: an incident with
	// no acknowledgement has fully escalated long before this.
	return time.Hour
}

// ── service account ──────────────────────────────────────────────────────────

type serviceAccount struct {
	Type        string `json:"type"`
	ProjectID   string `json:"project_id"`
	PrivateKey  string `json:"private_key"`
	ClientEmail string `json:"client_email"`
	TokenURI    string `json:"token_uri"`
}

// FCMClient talks to FCM HTTP v1. Safe for concurrent use: the access token is
// the only shared mutable state and it is behind a mutex.
type FCMClient struct {
	projectID   string
	clientEmail string
	tokenURI    string
	key         *rsa.PrivateKey
	http        *http.Client
	now         func() time.Time

	// sendURL and tokenURI are fields rather than constants so a test can point
	// them at an httptest server. Nothing else overrides them.
	sendURL string

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

// NewFCMFromEnv reads EnvFCMCredentials. It returns ErrPushNotConfigured when
// the variable is unset — the caller is expected to carry on without a push leg,
// not to fail its startup, because SMS and the socket still work and a control
// plane that refuses to boot rings nobody at all.
func NewFCMFromEnv(now func() time.Time) (*FCMClient, error) {
	path := strings.TrimSpace(os.Getenv(EnvFCMCredentials))
	if path == "" {
		return nil, ErrPushNotConfigured
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("notify: reading %s: %w", EnvFCMCredentials, err)
	}
	return NewFCM(raw, now)
}

// NewFCM builds a client from the bytes of a service-account JSON key.
func NewFCM(credentials []byte, now func() time.Time) (*FCMClient, error) {
	var sa serviceAccount
	if err := json.Unmarshal(credentials, &sa); err != nil {
		return nil, fmt.Errorf("notify: service account is not JSON: %w", err)
	}
	if sa.ProjectID == "" || sa.ClientEmail == "" || sa.PrivateKey == "" {
		return nil, errors.New("notify: service account needs project_id, client_email and private_key")
	}
	key, err := parsePrivateKey(sa.PrivateKey)
	if err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	tokenURI := sa.TokenURI
	if tokenURI == "" {
		tokenURI = "https://oauth2.googleapis.com/token"
	}
	return &FCMClient{
		projectID:   sa.ProjectID,
		clientEmail: sa.ClientEmail,
		tokenURI:    tokenURI,
		key:         key,
		// A push that has not landed in 10 s has lost its race with the SMS leg
		// (profiles[ChannelSMS] tops out at 8 s), so waiting longer only holds a
		// goroutine open on a delivery that no longer matters.
		http:    &http.Client{Timeout: 10 * time.Second},
		now:     now,
		sendURL: "https://fcm.googleapis.com/v1/projects/" + sa.ProjectID + "/messages:send",
	}, nil
}

func parsePrivateKey(pemText string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(pemText))
	if block == nil {
		return nil, errors.New("notify: private_key is not PEM")
	}
	// Google issues PKCS#8; PKCS#1 is accepted so a hand-converted key works too.
	if key, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		rsaKey, ok := key.(*rsa.PrivateKey)
		if !ok {
			return nil, fmt.Errorf("notify: private_key is %T, want RSA", key)
		}
		return rsaKey, nil
	}
	key, err := x509.ParsePKCS1PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("notify: private_key is neither PKCS#8 nor PKCS#1: %w", err)
	}
	return key, nil
}

// ── OAuth2: signed JWT → access token ────────────────────────────────────────

const fcmScope = "https://www.googleapis.com/auth/firebase.messaging"

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// signedJWT is the self-signed assertion Google trades for an access token.
func (c *FCMClient) signedJWT() (string, error) {
	now := c.now()
	header, err := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	if err != nil {
		return "", err
	}
	claims, err := json.Marshal(map[string]any{
		"iss":   c.clientEmail,
		"scope": fcmScope,
		"aud":   c.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	if err != nil {
		return "", err
	}
	signing := b64url(header) + "." + b64url(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, c.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("notify: signing the assertion: %w", err)
	}
	return signing + "." + b64url(sig), nil
}

// accessToken returns a cached token, refreshing it when it is within 60 s of
// expiry. The skew matters: an emergency fan-out is the worst possible moment to
// discover the token expired between the check and the send.
func (c *FCMClient) accessToken(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && c.now().Add(60*time.Second).Before(c.tokenExp) {
		return c.token, nil
	}

	assertion, err := c.signedJWT()
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"},
		"assertion":  {assertion},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.tokenURI,
		strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("notify: token endpoint: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("notify: reading token response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("notify: token endpoint returned %d: %s",
			resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("notify: token response is not JSON: %w", err)
	}
	if out.AccessToken == "" {
		return "", errors.New("notify: token response carried no access_token")
	}
	if out.ExpiresIn <= 0 {
		out.ExpiresIn = 3600
	}
	c.token = out.AccessToken
	c.tokenExp = c.now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return c.token, nil
}

// ── send ─────────────────────────────────────────────────────────────────────

// Send delivers one data-only, high-priority message to one device.
//
// The Android block is the difference between an alert and a notification that
// arrives when the OS feels like it: HIGH priority is what opens a Doze
// maintenance window immediately, and it is the reason F-21 forbids putting the
// text here — a data-only high-priority message is exactly the shape that wakes
// a killed app so the DEVICE can compose the alert (§12.2, P-055).
func (c *FCMClient) Send(ctx context.Context, token string, data map[string]string) error {
	if c == nil {
		return ErrPushNotConfigured
	}
	if strings.TrimSpace(token) == "" {
		return ErrPushUnregistered
	}
	if err := assertPushSafe(data); err != nil {
		return err
	}

	access, err := c.accessToken(ctx)
	if err != nil {
		return err
	}

	body, err := json.Marshal(map[string]any{
		"message": map[string]any{
			"token": token,
			"data":  data,
			"android": map[string]any{
				"priority": "HIGH",
				"ttl":      fmt.Sprintf("%ds", int64(pushTTL().Seconds())),
			},
		},
	})
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.sendURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("notify: fcm send: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusNotFound, isUnregistered(respBody):
		return ErrPushUnregistered
	case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
		// The cached token is worthless; drop it so the next attempt re-signs
		// rather than replaying a rejected credential for the next hour.
		c.mu.Lock()
		c.token, c.tokenExp = "", time.Time{}
		c.mu.Unlock()
		return fmt.Errorf("%w: %d %s", ErrPushRejected, resp.StatusCode,
			strings.TrimSpace(string(respBody)))
	default:
		return fmt.Errorf("%w: %d %s", ErrPushRejected, resp.StatusCode,
			strings.TrimSpace(string(respBody)))
	}
}

// isUnregistered reads FCM's error detail. A dead token can arrive as 404 or as
// a 400 whose body names UNREGISTERED or INVALID_ARGUMENT on the token field, so
// the status code alone is not enough to tell "this handset is gone" from "this
// deployment is misconfigured" — and only the first should clear a stored token.
func isUnregistered(body []byte) bool {
	var out struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return false
	}
	if strings.EqualFold(out.Error.Status, "NOT_FOUND") {
		return true
	}
	for _, d := range out.Error.Details {
		if strings.EqualFold(d.ErrorCode, "UNREGISTERED") {
			return true
		}
	}
	return false
}
