// Package envelope is the server-side mirror of the device's T0 wire formats:
// mobile/src/t0/envelope.ts primarily, plus the two things that travel with it —
// the inc8 prefix from core/ids.ts and the 160-character K1 SMS payload from
// t0/smsPayload.ts. They live together because they are one contract: an
// emergency that leaves a phone as a signed envelope and arrives as an SMS must
// still be recognised as the same emergency (F-09).
//
// PRD P-007: the SOS ingest endpoint does not accept bearer tokens at all. The
// only thing standing between a body and acceptance is an Ed25519 signature over
// the EXACT bytes the device produced — so this package never re-serialises a
// received body before verifying it. It verifies against the raw bytes and then
// reports, as an observation rather than a rejection, whether those bytes were
// canonical and fixed-size.
//
// F-01: the fixed 1024-byte size is the mitigation for threat T4 (an attacker
// watching the network for a size delta that betrays the duress bit). The device
// fails CLOSED when it cannot pad. The server, by ADR-018, fails OPEN: a wrong
// size or a bad signature is flagged and counted, never dropped. Those two
// asymmetric postures are deliberate and must not be "harmonised".
package envelope

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// FixedEnvelopeSize must equal FIXED_ENVELOPE_SIZE in mobile/src/t0/envelope.ts.
const FixedEnvelopeSize = 1024

// MaxBodyBytes bounds the request read (§2.5.1). A signed wrapper carrying a
// 1024-byte body plus a base64 signature is ~1.3 KB; 8 KB is generous headroom
// that still refuses to allocate on an attacker's say-so.
const MaxBodyBytes = 8 << 10

// Wire flags. Same bit positions as the TypeScript constants.
const (
	FlagUnverified      = 1 << 0
	FlagRelay           = 1 << 1
	FlagSMSOrigin       = 1 << 2
	FlagUnverifiedFlood = 1 << 3
)

var (
	// ErrTooLarge mirrors EnvelopeSizeError: the payload cannot fit inside the
	// fixed size, so the caller must retry minimal rather than emit a
	// variable-size envelope (KV-1004).
	ErrTooLarge = errors.New("envelope: payload exceeds the fixed size")
	// ErrMalformed is the only reason this package refuses a body outright.
	ErrMalformed = errors.New("envelope: malformed body")
)

// Envelope mirrors IncidentEnvelope field-for-field. Field ORDER here is
// load-bearing: it is the canonicalisation order, and it must stay identical to
// KEY_ORDER on the device or nothing signed on a phone will ever verify here.
type Envelope struct {
	V             int64  `json:"v"`
	IncidentID    string `json:"incidentId"`
	FamilyID      string `json:"familyId"`
	DeviceID      string `json:"deviceId"`
	MemberID      string `json:"memberId"`
	ClientTsMs    int64  `json:"clientTsMs"`
	HLC           string `json:"hlc"`
	Trigger       string `json:"trigger"`
	ConfidencePct int64  `json:"confidencePct"`
	RiskContext   int64  `json:"riskContext"`
	// Duress is ALWAYS serialised, both values (F-01).
	Duress        bool   `json:"duress"`
	IsDrill       bool   `json:"isDrill"`
	PolicyVersion int64  `json:"policyVersion"`
	CoarseCell    string `json:"coarseCell"`
	BatteryPct    int64  `json:"batteryPct"`
	SealedPayload string `json:"sealedPayload"`
	Flags         int64  `json:"flags"`
	Pad           string `json:"pad"`
}

// Signed is the POST body: the SignedEnvelope the device builds.
type Signed struct {
	Body       string `json:"body"`
	Signature  string `json:"signature"`
	DeviceID   string `json:"deviceId"`
	IncidentID string `json:"incidentId"`
}

// Anomaly records what was wrong with a body that we accepted anyway. Every bit
// is a metric, never a rejection.
type Anomaly uint8

const (
	// AnomalyWrongSize: the body was not exactly FixedEnvelopeSize bytes, so the
	// device's constant-size guarantee did not hold for this transport.
	AnomalyWrongSize Anomaly = 1 << iota
	// AnomalyNonCanonical: re-rendering the parsed envelope did not reproduce the
	// received bytes. Signature verification is unaffected (it uses raw bytes);
	// this flags a client that has drifted from the canonical form.
	AnomalyNonCanonical
)

func (a Anomaly) Has(f Anomaly) bool { return a&f != 0 }

func (a Anomaly) String() string {
	var parts []string
	if a.Has(AnomalyWrongSize) {
		parts = append(parts, "wrong_size")
	}
	if a.Has(AnomalyNonCanonical) {
		parts = append(parts, "non_canonical")
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, "|")
}

// ── canonicalisation ─────────────────────────────────────────────────────────
//
// Hand-rolled rather than encoding/json because encoding/json escapes U+2028 and
// U+2029 unconditionally and (by default) <, > and &, none of which JavaScript's
// JSON.stringify escapes. A single differing byte means every signature fails,
// which on this path means every SOS is flagged UNVERIFIED. The three-way
// agreement device⇄server⇄test is worth forty lines of explicit encoder.

func writeJSString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				const hex = "0123456789abcdef"
				b.WriteString(`\u00`)
				b.WriteByte(hex[(r>>4)&0xf])
				b.WriteByte(hex[r&0xf])
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// Canonical renders the envelope byte-for-byte identically to canonicalise() in
// mobile/src/t0/envelope.ts.
func Canonical(e *Envelope) []byte {
	var b strings.Builder
	b.Grow(FixedEnvelopeSize + 64)
	b.WriteByte('{')
	sep := ""
	key := func(k string) {
		b.WriteString(sep)
		sep = ","
		writeJSString(&b, k)
		b.WriteByte(':')
	}
	str := func(k, v string) { key(k); writeJSString(&b, v) }
	num := func(k string, v int64) { key(k); b.WriteString(strconv.FormatInt(v, 10)) }
	bol := func(k string, v bool) {
		key(k)
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	}

	num("v", e.V)
	str("incidentId", e.IncidentID)
	str("familyId", e.FamilyID)
	str("deviceId", e.DeviceID)
	str("memberId", e.MemberID)
	num("clientTsMs", e.ClientTsMs)
	str("hlc", e.HLC)
	str("trigger", e.Trigger)
	num("confidencePct", e.ConfidencePct)
	num("riskContext", e.RiskContext)
	bol("duress", e.Duress)
	bol("isDrill", e.IsDrill)
	num("policyVersion", e.PolicyVersion)
	str("coarseCell", e.CoarseCell)
	num("batteryPct", e.BatteryPct)
	str("sealedPayload", e.SealedPayload)
	num("flags", e.Flags)
	str("pad", e.Pad)

	b.WriteByte('}')
	return []byte(b.String())
}

// Pad sets e.Pad so that Canonical(e) is exactly FixedEnvelopeSize bytes.
// '.' is one byte in UTF-8 and needs no escaping, so the count is exact.
func Pad(e *Envelope) error {
	e.Pad = ""
	need := FixedEnvelopeSize - len(Canonical(e))
	if need < 0 {
		return ErrTooLarge
	}
	e.Pad = strings.Repeat(".", need)
	return nil
}

// tolerant is the decode target. Numbers arrive as json.Number so that a client
// that ever sends 87.5 where we expect 87 produces a non-canonical OBSERVATION
// instead of a parse failure — a parse failure here would drop an SOS.
type tolerant struct {
	V             *json.Number `json:"v"`
	IncidentID    string       `json:"incidentId"`
	FamilyID      string       `json:"familyId"`
	DeviceID      string       `json:"deviceId"`
	MemberID      string       `json:"memberId"`
	ClientTsMs    *json.Number `json:"clientTsMs"`
	HLC           string       `json:"hlc"`
	Trigger       string       `json:"trigger"`
	ConfidencePct *json.Number `json:"confidencePct"`
	RiskContext   *json.Number `json:"riskContext"`
	Duress        bool         `json:"duress"`
	IsDrill       bool         `json:"isDrill"`
	PolicyVersion *json.Number `json:"policyVersion"`
	CoarseCell    string       `json:"coarseCell"`
	BatteryPct    *json.Number `json:"batteryPct"`
	SealedPayload string       `json:"sealedPayload"`
	Flags         *json.Number `json:"flags"`
	Pad           string       `json:"pad"`
}

func asInt(n *json.Number) int64 {
	if n == nil {
		return 0
	}
	if i, err := n.Int64(); err == nil {
		return i
	}
	f, err := n.Float64()
	if err != nil {
		return 0
	}
	return int64(f)
}

// Parse decodes a received body. It returns an error ONLY when the bytes are not
// usable at all (unparseable JSON, or no incident/family identity to route on);
// everything else — wrong size, non-canonical rendering — comes back as an
// Anomaly that the caller counts and ignores.
func Parse(raw []byte) (*Envelope, Anomaly, error) {
	if len(raw) == 0 {
		return nil, 0, ErrMalformed
	}
	var t tolerant
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.UseNumber()
	// Unknown fields are tolerated on purpose: /v1 is frozen and additive-only,
	// so a newer client must never be refused by an older ingest node.
	if err := dec.Decode(&t); err != nil {
		return nil, 0, ErrMalformed
	}
	e := &Envelope{
		V:             asInt(t.V),
		IncidentID:    t.IncidentID,
		FamilyID:      t.FamilyID,
		DeviceID:      t.DeviceID,
		MemberID:      t.MemberID,
		ClientTsMs:    asInt(t.ClientTsMs),
		HLC:           t.HLC,
		Trigger:       t.Trigger,
		ConfidencePct: asInt(t.ConfidencePct),
		RiskContext:   asInt(t.RiskContext),
		Duress:        t.Duress,
		IsDrill:       t.IsDrill,
		PolicyVersion: asInt(t.PolicyVersion),
		CoarseCell:    t.CoarseCell,
		BatteryPct:    asInt(t.BatteryPct),
		SealedPayload: t.SealedPayload,
		Flags:         asInt(t.Flags),
		Pad:           t.Pad,
	}
	if e.IncidentID == "" || e.FamilyID == "" {
		return nil, 0, ErrMalformed
	}

	var an Anomaly
	if len(raw) != FixedEnvelopeSize {
		an |= AnomalyWrongSize
	}
	if string(Canonical(e)) != string(raw) {
		an |= AnomalyNonCanonical
	}
	return e, an, nil
}

// Verify checks the Ed25519 signature over the RAW received bytes.
func Verify(raw, sig []byte, pub ed25519.PublicKey) bool {
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(pub, raw, sig)
}

// VerifyB64 is the request-path form: a base64 signature as it appears in the
// SignedEnvelope wrapper or the X-Sig header.
func VerifyB64(raw []byte, sigB64 string, pub ed25519.PublicKey) bool {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil {
		return false
	}
	return Verify(raw, sig, pub)
}

// ═══════════════════════════════════════════════════════════════════════════════
// TWO ALGORITHMS, BECAUSE THE ALGORITHM IS A PROPERTY OF THE KEY
//
// mobile/src/crypto/hardware.ts prefers a key the JS runtime cannot read. On
// Android that key is EC P-256 signed SHA256withECDSA, not Ed25519 — Android
// Keystore gained Curve25519 only at API 33, and Kavach ships to API 26 onto
// exactly the mid-range phones that do not have it. Where no keystore key can be
// had, the @noble Ed25519 key in the JS heap still signs.
//
// So one family holds both kinds at once, and one device changes kind across a
// reinstall onto newer hardware. The verifier picks by looking at the key it has
// on file, never at a field the sender chose: a self-declared algorithm is an
// attacker-controlled downgrade, and there is no reason to accept one when the
// encoding already says which it is (32 raw bytes = Ed25519, DER = P-256).
//
// ★ THE VERIFIER SHIPS BEFORE THE SIGNER ★ Deployed in this order, a device that
// starts emitting P-256 meets a server that already understands it. Reversed, by
// ADR-018 every real emergency from an upgraded phone would be accepted and
// flagged UNVERIFIED — silent, survivable, and a total loss of the property.
// ═══════════════════════════════════════════════════════════════════════════════

// SignatureAlg mirrors the type of the same name in mobile/src/crypto/hardware.ts.
type SignatureAlg string

const (
	AlgEd25519   SignatureAlg = "ed25519"
	AlgECDSAP256 SignatureAlg = "ecdsa-p256"
)

// VerifyingKey is a device's public signing key together with the algorithm it
// verifies under. The zero value verifies nothing; check Valid.
type VerifyingKey struct {
	Alg SignatureAlg
	ed  ed25519.PublicKey
	ec  *ecdsa.PublicKey
}

// ErrUnknownKeyFormat is returned for bytes that are neither of the two accepted
// encodings. Callers on the cache path skip such a key rather than failing:
// a device whose key we cannot parse is a device whose incidents arrive
// unverified, which is ADR-018 working, not a reason to refuse traffic.
var ErrUnknownKeyFormat = errors.New("envelope: public key is neither 32-byte Ed25519 nor P-256 SubjectPublicKeyInfo")

// ParseVerifyingKey decides the algorithm from the encoding.
//
// 32 raw bytes is Ed25519 — the length is unambiguous, because the smallest
// possible P-256 SubjectPublicKeyInfo is 91 bytes. Anything else must parse as
// X.509 SPKI carrying a P-256 point, which is precisely what
// KeyVault.publicKey() returns from KeyStore.getCertificate().getPublicKey().
func ParseVerifyingKey(pub []byte) (VerifyingKey, error) {
	if len(pub) == ed25519.PublicKeySize {
		return VerifyingKey{Alg: AlgEd25519, ed: ed25519.PublicKey(append([]byte(nil), pub...))}, nil
	}
	parsed, err := x509.ParsePKIXPublicKey(pub)
	if err != nil {
		return VerifyingKey{}, ErrUnknownKeyFormat
	}
	ec, ok := parsed.(*ecdsa.PublicKey)
	// Curve is pinned. An SPKI naming P-384 or P-521 parses fine and would verify
	// fine, and accepting it would mean the fleet quietly runs an algorithm no
	// device was ever provisioned with and no test covers.
	if !ok || ec.Curve != elliptic.P256() {
		return VerifyingKey{}, ErrUnknownKeyFormat
	}
	return VerifyingKey{Alg: AlgECDSAP256, ec: ec}, nil
}

// ParseVerifyingKeyB64 is the store-path form: the key as it is persisted.
func ParseVerifyingKeyB64(pubB64 string) (VerifyingKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(pubB64))
	if err != nil {
		return VerifyingKey{}, ErrUnknownKeyFormat
	}
	return ParseVerifyingKey(raw)
}

// Valid reports whether this key can verify anything at all.
func (k VerifyingKey) Valid() bool {
	switch k.Alg {
	case AlgEd25519:
		return len(k.ed) == ed25519.PublicKeySize
	case AlgECDSAP256:
		return k.ec != nil
	default:
		return false
	}
}

// Verify checks a signature over the RAW received bytes — never over anything
// re-serialised, which is how a verifier ends up checking a signature over bytes
// the device never produced.
func (k VerifyingKey) Verify(raw, sig []byte) bool {
	switch k.Alg {
	case AlgEd25519:
		return Verify(raw, sig, k.ed)
	case AlgECDSAP256:
		if k.ec == nil {
			return false
		}
		// SHA256withECDSA on the Android side: the JCA signer hashes, then emits
		// an ASN.1 DER SEQUENCE of r and s. VerifyASN1 expects exactly that, and
		// expects the digest rather than the message.
		sum := sha256.Sum256(raw)
		return ecdsa.VerifyASN1(k.ec, sum[:], sig)
	default:
		return false
	}
}

// VerifyB64 is the request-path form: a base64 signature as it appears in the
// SignedEnvelope wrapper or the X-Sig header.
func (k VerifyingKey) VerifyB64(raw []byte, sigB64 string) bool {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sigB64))
	if err != nil {
		return false
	}
	return k.Verify(raw, sig)
}

// Seal pads, canonicalises and signs. Used by the relay/SMS synthesis paths and
// by conformance tests; the device does the same thing in TypeScript.
func Seal(e *Envelope, priv ed25519.PrivateKey) (*Signed, error) {
	if err := Pad(e); err != nil {
		return nil, err
	}
	body := Canonical(e)
	if len(body) != FixedEnvelopeSize {
		// Fail closed exactly as the device does: a mis-padded envelope leaks the
		// duress bit, and a leak is worse than a fallback transport.
		return nil, ErrTooLarge
	}
	return &Signed{
		Body:       string(body),
		Signature:  base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body)),
		DeviceID:   e.DeviceID,
		IncidentID: e.IncidentID,
	}, nil
}

// Inc8 mirrors inc8() in mobile/src/core/ids.ts: the 8-character base36 prefix
// carried in the 160-character SMS payload and used to reconcile an SMS-borne
// incident against the HTTP one (F-09).
func Inc8(incidentID string) string {
	const digits = "0123456789abcdefghijklmnopqrstuvwxyz"
	h := strings.ReplaceAll(incidentID, "-", "")
	if len(h) > 16 {
		h = h[:16]
	}
	v, err := strconv.ParseUint(h, 16, 64)
	if err != nil {
		// A malformed id must still yield a stable prefix — the SMS path has no
		// second chance to ask the device to repeat itself.
		sum := sha256.Sum256([]byte(incidentID))
		for i := 0; i < 8; i++ {
			v = v<<8 | uint64(sum[i])
		}
	}
	out := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		out[i] = digits[v%36]
		v /= 36
	}
	return string(out)
}

// ── K1 SMS payload (mirror of mobile/src/t0/smsPayload.ts) ───────────────────

// SMSProtocol is the first field of every Kavach SMS.
const SMSProtocol = "K1"

// SMS is a decoded K1 payload. Lat/Lon are Class A′: usable for fan-out in
// memory, never for persistence (§2.4.6).
type SMS struct {
	Inc8       string
	ShortName  string
	Code       string
	Lat, Lon   float64
	AccuracyM  int
	BatteryPct int
	AtMs       int64
	Sig        string
}

// DecodeSMS parses the machine-readable head of a K1 message and also returns
// the exact substring the sig8 tag covers. ok=false only when the text is not a
// K1 payload at all — a bad tag is the caller's decision to flag, never ours to
// drop (ADR-018).
func DecodeSMS(text string) (SMS, string, bool) {
	machine := strings.SplitN(strings.TrimSpace(text), " ", 2)[0]
	p := strings.Split(machine, "|")
	if len(p) < 9 || p[0] != SMSProtocol {
		return SMS{}, "", false
	}
	coords := strings.SplitN(p[4], ",", 2)
	if len(coords) != 2 {
		return SMS{}, "", false
	}
	lat, err1 := strconv.ParseFloat(coords[0], 64)
	lon, err2 := strconv.ParseFloat(coords[1], 64)
	if err1 != nil || err2 != nil || math.IsNaN(lat) || math.IsNaN(lon) {
		return SMS{}, "", false
	}
	acc, _ := strconv.Atoi(p[5])
	bat, _ := strconv.Atoi(p[6])
	secs, _ := strconv.ParseInt(p[7], 36, 64)
	return SMS{
		Inc8: p[1], ShortName: p[2], Code: p[3], Lat: lat, Lon: lon,
		AccuracyM: acc, BatteryPct: bat, AtMs: secs * 1000, Sig: p[8],
	}, strings.Join(p[:8], "|"), true
}

// SMSTag mirrors smsTag() in mobile/src/crypto: 8 base64url characters of
// HMAC-SHA256 truncated to 6 bytes, as budgeted inside the 160-character limit.
func SMSTag(key []byte, payload string) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(payload))
	s := base64.StdEncoding.EncodeToString(mac.Sum(nil)[:6])
	s = strings.NewReplacer("+", "-", "/", "_").Replace(s)
	if len(s) > 8 {
		s = s[:8]
	}
	return s
}

var triggerByCode = map[string]string{
	"SOS": "MANUAL", "CRA": "CRASH", "FAL": "FALL", "NOM": "NO_MOTION",
	"DED": "DEADMAN", "GEO": "GEOFENCE", "HOM": "SENSOR_HOME", "SIL": "DEVICE_SILENCED",
	"FOB": "BLE_FOB", "VOI": "VOICE_PHRASE", "REL": "RELAY", "DRL": "DRILL",
}

// TriggerForCode expands a 3-character SMS trigger code. An unknown code
// degrades to MANUAL rather than to nothing: the wrong label on a real
// emergency is survivable, a dropped emergency is not.
func TriggerForCode(code string) string {
	if t, ok := triggerByCode[code]; ok {
		return t
	}
	return "MANUAL"
}

// CoarseCell mirrors coarseCell() in mobile/src/core/ids.ts. ≈1 km:
// deliberately too coarse to identify a home, and the ONLY plaintext location
// the server is allowed to keep (§10.2).
func CoarseCell(lat, lon float64) string {
	la := math.Floor(lat*100) / 100
	lo := math.Floor(lon*100) / 100
	return "c7:" + strconv.FormatFloat(la, 'f', 2, 64) + ":" + strconv.FormatFloat(lo, 'f', 2, 64)
}

// nsKavach is the UUIDv5 namespace for deterministic, SMS-derived incident ids.
var nsKavach = [16]byte{
	0x6b, 0x8f, 0x2f, 0x1e, 0x0b, 0x6a, 0x5a, 0x3e,
	0x9c, 0x1d, 0x4a, 0x7f, 0x2e, 0x6d, 0x8c, 0x50,
}

// UUIDv5 derives a stable id inside the Kavach namespace. Determinism is the
// whole point: the same (family, inc8, time window) must produce the same id in
// every process and after every restart, or a second SMS about one emergency
// becomes a third incident (F-09).
func UUIDv5(name string) string {
	h := sha1.New()
	h.Write(nsKavach[:])
	h.Write([]byte(name))
	var b [16]byte
	copy(b[:], h.Sum(nil)[:16])
	b[6] = (b[6] & 0x0f) | 0x50
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
