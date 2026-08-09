package envelope

// ═══════════════════════════════════════════════════════════════════════════════
// THE VERIFIER MUST ACCEPT BOTH KINDS OF KEY AND CONFUSE NEITHER
//
// mobile/src/crypto/hardware.ts signs with an AndroidKeyStore P-256 key when the
// phone has one and with the Ed25519 key in the JS heap when it does not, so a
// single family holds both at once. These tests pin the three properties that
// makes safe:
//
//   1. each key kind verifies its own signatures,
//   2. neither verifies the other's — a cross-algorithm accept would let anyone
//      holding one signature type forge the other,
//   3. the algorithm comes from the KEY's encoding and never from anything the
//      sender said, so there is no downgrade to negotiate.
//
// ★ WHAT THESE TESTS DO NOT PROVE ★ The P-256 signatures below are produced by
// Go's crypto/ecdsa, not by Android's SHA256withECDSA through the JCA. Both are
// specified to emit an ASN.1 DER SEQUENCE of r and s over a SHA-256 digest, and
// that agreement is the assumption this file rests on. It is verified for real
// only by a device signing through KeyVault.kt and this code accepting it —
// the same gap crosslang_test.go exists to close for Ed25519, and it stays open
// for P-256 until a phone with a keystore runs the round trip.

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"testing"
)

func mustP256(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-256: %v", err)
	}
	spki, err := x509.MarshalPKIXPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatalf("marshal SPKI: %v", err)
	}
	return priv, spki
}

// signP256 does what Android's SHA256withECDSA does: hash with SHA-256, then
// emit the DER SEQUENCE.
func signP256(t *testing.T, priv *ecdsa.PrivateKey, body []byte) []byte {
	t.Helper()
	sum := sha256.Sum256(body)
	sig, err := ecdsa.SignASN1(rand.Reader, priv, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return sig
}

func TestParseVerifyingKeyPicksAlgorithmFromEncoding(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519: %v", err)
	}
	k, err := ParseVerifyingKey(pub)
	if err != nil {
		t.Fatalf("32 raw bytes must parse as Ed25519: %v", err)
	}
	if k.Alg != AlgEd25519 || !k.Valid() {
		t.Fatalf("got alg %q valid=%v, want ed25519 and valid", k.Alg, k.Valid())
	}

	_, spki := mustP256(t)
	k2, err := ParseVerifyingKey(spki)
	if err != nil {
		t.Fatalf("P-256 SPKI must parse: %v", err)
	}
	if k2.Alg != AlgECDSAP256 || !k2.Valid() {
		t.Fatalf("got alg %q valid=%v, want ecdsa-p256 and valid", k2.Alg, k2.Valid())
	}

	// The length rule the parser leans on: no P-256 SPKI can be 32 bytes.
	if len(spki) == ed25519.PublicKeySize {
		t.Fatalf("P-256 SPKI is %d bytes — the length dispatch in ParseVerifyingKey is unsound", len(spki))
	}
}

func TestVerifyingKeyVerifiesItsOwnSignatures(t *testing.T) {
	body := []byte(`{"v":1,"incidentId":"0192f0c1-0000-7000-8000-000000000001"}`)

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519: %v", err)
	}
	edKey, err := ParseVerifyingKey(pub)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !edKey.Verify(body, ed25519.Sign(priv, body)) {
		t.Fatal("Ed25519 key refused an Ed25519 signature over the same bytes")
	}

	ecPriv, spki := mustP256(t)
	ecKey, err := ParseVerifyingKey(spki)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !ecKey.Verify(body, signP256(t, ecPriv, body)) {
		t.Fatal("P-256 key refused a SHA256withECDSA signature over the same bytes")
	}
}

// ★ The one that matters. An accept here is a forgery primitive. ★
func TestVerifyingKeyRefusesTheOtherAlgorithm(t *testing.T) {
	body := []byte("KAVACH SOS")

	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	edKey, _ := ParseVerifyingKey(pub)
	ecPriv, spki := mustP256(t)
	ecKey, _ := ParseVerifyingKey(spki)

	if edKey.Verify(body, signP256(t, ecPriv, body)) {
		t.Fatal("an Ed25519 key accepted an ECDSA signature")
	}
	if ecKey.Verify(body, ed25519.Sign(priv, body)) {
		t.Fatal("a P-256 key accepted an Ed25519 signature")
	}
}

func TestVerifyingKeyRefusesTamperedBody(t *testing.T) {
	body := []byte("KAVACH SOS trigger=MANUAL duress=false")
	ecPriv, spki := mustP256(t)
	k, _ := ParseVerifyingKey(spki)
	sig := signP256(t, ecPriv, body)

	if !k.Verify(body, sig) {
		t.Fatal("precondition: the untampered body must verify")
	}
	// Flip the duress bit — the exact edit an attacker with the transcript wants.
	tampered := []byte("KAVACH SOS trigger=MANUAL duress=true ")
	if k.Verify(tampered, sig) {
		t.Fatal("a P-256 signature verified over bytes it was not made over")
	}
}

func TestParseVerifyingKeyRejectsEverythingElse(t *testing.T) {
	p384, err := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	if err != nil {
		t.Fatalf("generate P-384: %v", err)
	}
	p384SPKI, err := x509.MarshalPKIXPublicKey(&p384.PublicKey)
	if err != nil {
		t.Fatalf("marshal P-384: %v", err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA: %v", err)
	}
	rsaSPKI, err := x509.MarshalPKIXPublicKey(&rsaKey.PublicKey)
	if err != nil {
		t.Fatalf("marshal RSA: %v", err)
	}

	cases := []struct {
		name string
		in   []byte
	}{
		// Parses as a valid SPKI and would verify correctly — refused anyway,
		// because no device is provisioned with one and nothing tests that path.
		{"P-384 SPKI", p384SPKI},
		{"RSA SPKI", rsaSPKI},
		{"empty", nil},
		{"31 bytes", make([]byte, 31)},
		{"33 bytes", make([]byte, 33)},
		{"garbage of plausible length", make([]byte, 91)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			k, err := ParseVerifyingKey(c.in)
			if err == nil {
				t.Fatalf("accepted %s as alg %q", c.name, k.Alg)
			}
			if k.Valid() {
				t.Fatal("a key that failed to parse reported itself valid")
			}
			if k.Verify([]byte("x"), []byte("y")) {
				t.Fatal("a key that failed to parse verified something")
			}
		})
	}
}

func TestZeroVerifyingKeyVerifiesNothing(t *testing.T) {
	var k VerifyingKey
	if k.Valid() {
		t.Fatal("the zero value must not report itself valid")
	}
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	body := []byte("KAVACH SOS")
	// A real signature by a real key, against the zero value: still no.
	if k.Verify(body, ed25519.Sign(priv, body)) {
		t.Fatal("the zero value verified a genuine signature")
	}
	if len(pub) != ed25519.PublicKeySize {
		t.Fatalf("ed25519 public key size changed: %d", len(pub))
	}
}

func TestVerifyB64MatchesTheWireForm(t *testing.T) {
	body := []byte("KAVACH SOS")
	ecPriv, spki := mustP256(t)
	k, _ := ParseVerifyingKey(spki)
	sig := signP256(t, ecPriv, body)

	if !k.VerifyB64(body, base64.StdEncoding.EncodeToString(sig)) {
		t.Fatal("VerifyB64 refused what Verify accepted")
	}
	// Whitespace survives some header paths; a trimmed decode must still work.
	if !k.VerifyB64(body, " "+base64.StdEncoding.EncodeToString(sig)+"\n") {
		t.Fatal("VerifyB64 refused a padded-with-whitespace signature")
	}
	if k.VerifyB64(body, "not base64 !!") {
		t.Fatal("VerifyB64 accepted an undecodable signature")
	}
}

func TestParseVerifyingKeyB64RoundTrips(t *testing.T) {
	_, spki := mustP256(t)
	k, err := ParseVerifyingKeyB64(base64.StdEncoding.EncodeToString(spki))
	if err != nil {
		t.Fatalf("parse from base64: %v", err)
	}
	if k.Alg != AlgECDSAP256 {
		t.Fatalf("alg %q, want ecdsa-p256", k.Alg)
	}
	if _, err := ParseVerifyingKeyB64("!!!"); err == nil {
		t.Fatal("accepted a non-base64 key")
	}
}

// The new API must agree with the old one on the path that is already shipping,
// so that switching sos-ingest to VerifyingKey changed no Ed25519 outcome.
func TestVerifyingKeyAgreesWithLegacyVerify(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	e := &Envelope{
		V: 1, IncidentID: "0192f0c1-0000-7000-8000-000000000001",
		FamilyID: "fam-1", DeviceID: "dev-1", MemberID: "mem-1",
		ClientTsMs: 1_700_000_000_000, HLC: "0000000000000000deadbeef",
		Trigger: "MANUAL", ConfidencePct: 100, CoarseCell: "c7:19.07:72.87",
	}
	signed, err := Seal(e, priv)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	raw := []byte(signed.Body)
	if len(raw) != FixedEnvelopeSize {
		t.Fatalf("body is %d bytes, want %d", len(raw), FixedEnvelopeSize)
	}

	k, err := ParseVerifyingKey(pub)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	legacy := VerifyB64(raw, signed.Signature, pub)
	if !legacy {
		t.Fatal("precondition: the legacy verifier must accept a sealed envelope")
	}
	if got := k.VerifyB64(raw, signed.Signature); got != legacy {
		t.Fatalf("VerifyingKey said %v where the legacy verifier said %v", got, legacy)
	}
}
