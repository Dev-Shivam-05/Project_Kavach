// ═══════════════════════════════════════════════════════════════════════════════
// CHARACTERIZATION — the append-only log underneath an SOS
// (ADR-002 · docs/02 §2.5.1 step 2 · docs/RISK.md item 4 · docs/DECISIONS.md D-027)
//
// internal/wal had zero tests. It is the file that makes an SOS durable BEFORE
// the device is told "help is on the way", and D-027 is about to change how it
// opens and how it writes. Nothing below is a new requirement: every assertion
// states what the code at HEAD already does, so that the multi-writer work has
// something to break loudly rather than quietly.
//
// The last test in this file, TestReplayReadsOnlyUpToThisInstancesOwnSize, is
// D-027's root cause expressed in wal's own terms.
// ═══════════════════════════════════════════════════════════════════════════════

package wal

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openAt(t *testing.T, path string) *WAL {
	t.Helper()
	w, err := Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

func tmpWAL(t *testing.T) (*WAL, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.wal")
	return openAt(t, path), path
}

// payloads replays the log into a slice of strings, in write order.
func payloads(t *testing.T, w *WAL) []string {
	t.Helper()
	var out []string
	if err := w.Replay(func(seq uint64, _ int64, p []byte) error {
		if seq != uint64(len(out))+1 {
			t.Fatalf("Replay handed seq %d for record %d; it is documented 1-based and dense", seq, len(out))
		}
		out = append(out, string(p))
		return nil
	}); err != nil {
		t.Fatalf("replay: %v", err)
	}
	return out
}

// ── the file format ──────────────────────────────────────────────────────────

// TestOpenCreatesAnEightByteHeaderedFile pins the on-disk header. Anything that
// changes these 8 bytes makes every existing sos.wal unreadable.
func TestOpenCreatesAnEightByteHeaderedFile(t *testing.T) {
	w, path := tmpWAL(t)
	if got := w.Size(); got != headerSize {
		t.Fatalf("Size() = %d on a fresh log, want %d", got, headerSize)
	}
	if got := w.Count(); got != 0 {
		t.Fatalf("Count() = %d on a fresh log, want 0", got)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if want := []byte{'K', 'V', 'W', 'A', 'L', 0x00, 0x01, '\n'}; string(raw) != string(want) {
		t.Fatalf("header = %q, want %q", raw, want)
	}
}

// TestOpenRefusesAFileThatIsNotAKavachWAL — a wrong KAVACH_SOS_DATA that points
// at somebody else's file must fail loudly at boot, not append to it.
func TestOpenRefusesAFileThatIsNotAKavachWAL(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notours.wal")
	if err := os.WriteFile(path, []byte("this is a text file, not a log"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := Open(path)
	if err == nil {
		t.Fatal("Open accepted a file with a foreign header")
	}
	if !strings.Contains(err.Error(), "not a kavach WAL") {
		t.Fatalf("error = %v, want it to name the format", err)
	}
}

// ── append / replay / read ───────────────────────────────────────────────────

func TestAppendThenReplayReturnsRecordsInWriteOrder(t *testing.T) {
	w, _ := tmpWAL(t)
	want := []string{"first", "second", "third"}
	for _, p := range want {
		if _, err := w.Append([]byte(p)); err != nil {
			t.Fatalf("append %q: %v", p, err)
		}
	}
	got := payloads(t, w)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("replay = %v, want %v", got, want)
	}
	if w.Count() != 3 {
		t.Fatalf("Count() = %d, want 3", w.Count())
	}
}

// TestReadAtReturnsTheRecordStoredAtTheOffsetAppendReported pins the offset
// contract: what Append returns is what ReadAt takes.
func TestReadAtReturnsTheRecordStoredAtTheOffsetAppendReported(t *testing.T) {
	w, _ := tmpWAL(t)
	offs := make([]int64, 0, 3)
	for _, p := range []string{"alpha", "beta", "gamma"} {
		off, err := w.AppendSync([]byte(p))
		if err != nil {
			t.Fatal(err)
		}
		offs = append(offs, off)
	}
	if offs[0] != headerSize {
		t.Fatalf("first record at offset %d, want %d (immediately after the header)", offs[0], headerSize)
	}
	for i, want := range []string{"alpha", "beta", "gamma"} {
		got, err := w.ReadAt(offs[i])
		if err != nil {
			t.Fatalf("ReadAt(%d): %v", offs[i], err)
		}
		if string(got) != want {
			t.Fatalf("ReadAt(%d) = %q, want %q", offs[i], got, want)
		}
	}
	if _, err := w.ReadAt(headerSize - 1); err == nil {
		t.Fatal("ReadAt accepted an offset inside the header")
	}
}

func TestAppendRefusesEmptyAndOversizeRecords(t *testing.T) {
	w, _ := tmpWAL(t)
	if _, err := w.Append(nil); !errors.Is(err, ErrRecordTooLarge) {
		t.Fatalf("Append(nil) = %v, want ErrRecordTooLarge", err)
	}
	if _, err := w.Append(make([]byte, MaxRecord+1)); !errors.Is(err, ErrRecordTooLarge) {
		t.Fatalf("Append(MaxRecord+1) = %v, want ErrRecordTooLarge", err)
	}
	if w.Count() != 0 {
		t.Fatalf("Count() = %d after two refused appends, want 0", w.Count())
	}
}

// TestAnAppendedRecordSurvivesCloseAndReopen is the ADR-002 sentence as a test:
// if the process dies one instruction after AppendSync returns, the incident is
// still there at boot.
func TestAnAppendedRecordSurvivesCloseAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sos.wal")
	w := openAt(t, path)
	if _, err := w.AppendSync([]byte(`{"incident":"i-1"}`)); err != nil {
		t.Fatal(err)
	}
	sizeBefore := w.Size()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	again := openAt(t, path)
	if got := payloads(t, again); len(got) != 1 || got[0] != `{"incident":"i-1"}` {
		t.Fatalf("after reopen: %v, want the one incident", got)
	}
	if again.Size() != sizeBefore {
		t.Fatalf("Size() = %d after reopen, want %d", again.Size(), sizeBefore)
	}
	if torn, _ := again.TornTailTruncated(); torn {
		t.Fatal("a clean close was reported as a torn tail")
	}
}

func TestEveryMethodRefusesAfterClose(t *testing.T) {
	w, _ := tmpWAL(t)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Append([]byte("x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("Append after Close = %v, want ErrClosed", err)
	}
	if _, err := w.AppendSync([]byte("x")); !errors.Is(err, ErrClosed) {
		t.Fatalf("AppendSync after Close = %v, want ErrClosed", err)
	}
	if err := w.Sync(); !errors.Is(err, ErrClosed) {
		t.Fatalf("Sync after Close = %v, want ErrClosed", err)
	}
	if err := w.Replay(func(uint64, int64, []byte) error { return nil }); !errors.Is(err, ErrClosed) {
		t.Fatalf("Replay after Close = %v, want ErrClosed", err)
	}
	if _, err := w.ReadAt(headerSize); !errors.Is(err, ErrClosed) {
		t.Fatalf("ReadAt after Close = %v, want ErrClosed", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("second Close = %v, want nil", err)
	}
}

// ── crash repair ─────────────────────────────────────────────────────────────

// appendRaw writes bytes straight onto the end of the file, the way a process
// that died mid-write would have left them.
func appendRaw(t *testing.T, path string, b []byte) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(b, st.Size()); err != nil {
		t.Fatal(err)
	}
}

// TestOpenTruncatesAShortTailAndSaysSo — the tail is a half-written record
// header. Open repairs it, keeps every intact record before it, and reports the
// repair, because /healthz treats a silent repair as an operational event.
func TestOpenTruncatesAShortTailAndSaysSo(t *testing.T) {
	path := filepath.Join(t.TempDir(), "torn.wal")
	w := openAt(t, path)
	if _, err := w.AppendSync([]byte("intact")); err != nil {
		t.Fatal(err)
	}
	good := w.Size()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	appendRaw(t, path, []byte{0, 0, 0}) // three bytes of an eight-byte record header

	again := openAt(t, path)
	torn, at := again.TornTailTruncated()
	if !torn {
		t.Fatal("TornTailTruncated() = false after a short tail")
	}
	if at != good {
		t.Fatalf("torn at %d, want %d (the end of the last intact record)", at, good)
	}
	if again.Size() != good {
		t.Fatalf("Size() = %d after repair, want %d", again.Size(), good)
	}
	if got := payloads(t, again); len(got) != 1 || got[0] != "intact" {
		t.Fatalf("after repair: %v, want [intact]", got)
	}
}

// TestOpenTruncatesFromARecordWhoseCRCDoesNotMatch — a full-length record whose
// bytes were corrupted is not served. Everything before it survives.
func TestOpenTruncatesFromARecordWhoseCRCDoesNotMatch(t *testing.T) {
	path := filepath.Join(t.TempDir(), "crc.wal")
	w := openAt(t, path)
	if _, err := w.AppendSync([]byte("keep-me")); err != nil {
		t.Fatal(err)
	}
	good := w.Size()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	// A well-framed record whose checksum belongs to different bytes.
	payload := []byte("corrupt")
	rec := make([]byte, recHeader+len(payload))
	binary.BigEndian.PutUint32(rec[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(rec[4:8], crc32.ChecksumIEEE([]byte("something else")))
	copy(rec[recHeader:], payload)
	appendRaw(t, path, rec)

	again := openAt(t, path)
	if torn, at := again.TornTailTruncated(); !torn || at != good {
		t.Fatalf("TornTailTruncated() = (%v, %d), want (true, %d)", torn, at, good)
	}
	if got := payloads(t, again); len(got) != 1 || got[0] != "keep-me" {
		t.Fatalf("after repair: %v, want [keep-me]", got)
	}
}

// ── D-027, in wal's own terms ────────────────────────────────────────────────

// TestReplayReadsOnlyUpToThisInstancesOwnSize is why nothing in this system has
// ever crossed a process. `end` is w.size (wal.go, Replay), and w.size is set
// once at Open and advanced only by THIS instance's appends. Records that
// arrived in the file by any other route are outside the window and are never
// looked at.
//
// The bus is built directly on this, which is why a second *Bus on the same
// directory receives nothing (internal/bus/crossprocess_test.go).
func TestReplayReadsOnlyUpToThisInstancesOwnSize(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shared.wal")
	reader := openAt(t, path)

	// Somebody else appends a perfectly valid record to the same file.
	writer := openAt(t, path)
	if _, err := writer.AppendSync([]byte("from-the-other-process")); err != nil {
		t.Fatal(err)
	}

	if got := payloads(t, reader); len(got) != 0 {
		t.Fatalf("reader replayed %v; it has learned to read the whole file, "+
			"which is what D-027 needs. Re-read the comment above", got)
	}
	if reader.Size() != headerSize {
		t.Fatalf("reader Size() = %d, want %d; it never noticed the file grew", reader.Size(), headerSize)
	}
}
