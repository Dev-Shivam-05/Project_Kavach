// ═══════════════════════════════════════════════════════════════════════════════
// OpenShared — the multi-process half of the log (D-027 · ADR-007 · docs/RISK.md 17)
//
// wal_test.go pins what a single writer does. This file pins what happens when
// there is more than one, which is the case ops/docker-compose.yml has always
// assumed and the code has never supported.
//
// TestTwoRealProcessesAppendToOneSharedLog is the reason this file exists in
// this shape. D-027 was measured with two handles inside one test binary and
// said so, honestly, in its own text: "what is inferred is that containers
// behave as separate instances do". That inference is now unnecessary — the
// test re-executes the test binary as a second OS process and lets the two race
// for the same file.
// ═══════════════════════════════════════════════════════════════════════════════

package wal

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func openSharedAt(t *testing.T, path string) *WAL {
	t.Helper()
	w, err := OpenShared(path)
	if err != nil {
		t.Fatalf("OpenShared %s: %v", path, err)
	}
	t.Cleanup(func() { _ = w.Close() })
	return w
}

// tailAll drains the log from `from` and returns the payloads plus the next
// offset, which is what a caller is expected to hold on to.
func tailAll(t *testing.T, w *WAL, from int64) ([]string, int64) {
	t.Helper()
	var out []string
	next, err := w.Tail(from, func(_ int64, p []byte) error {
		out = append(out, string(p))
		return nil
	})
	if err != nil {
		t.Fatalf("tail from %d: %v", from, err)
	}
	return out, next
}

// ── the inversion of TestReplayReadsOnlyUpToThisInstancesOwnSize ─────────────

// TestTailSeesRecordsAnotherHandleAppended is D-027's headline, the right way
// round. Its single-writer twin in wal_test.go asserts the opposite for Open,
// and both are true: the mode is the difference.
func TestTailSeesRecordsAnotherHandleAppended(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.wal")
	reader := openSharedAt(t, path)
	writer := openSharedAt(t, path)

	if _, err := writer.AppendSync([]byte("from-the-other-process")); err != nil {
		t.Fatal(err)
	}

	got, next := tailAll(t, reader, 0)
	if len(got) != 1 || got[0] != "from-the-other-process" {
		t.Fatalf("Tail = %v, want one record written by the other handle", got)
	}
	if next <= headerSize {
		t.Fatalf("Tail returned offset %d, want it past the header", next)
	}
}

func TestTailResumesFromTheOffsetItReturned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.wal")
	reader := openSharedAt(t, path)
	writer := openSharedAt(t, path)

	if _, err := writer.Append([]byte("one")); err != nil {
		t.Fatal(err)
	}
	first, next := tailAll(t, reader, 0)
	if len(first) != 1 {
		t.Fatalf("first tail = %v, want one record", first)
	}

	// Nothing new: the same offset comes back and the callback is not invoked.
	again, next2 := tailAll(t, reader, next)
	if len(again) != 0 {
		t.Fatalf("second tail re-delivered %v; a cursor that does not hold is not a cursor", again)
	}
	if next2 != next {
		t.Fatalf("offset moved from %d to %d with nothing written", next, next2)
	}

	if _, err := writer.Append([]byte("two")); err != nil {
		t.Fatal(err)
	}
	third, _ := tailAll(t, reader, next2)
	if len(third) != 1 || third[0] != "two" {
		t.Fatalf("third tail = %v, want [two] only", third)
	}
}

// TestTailStopsAtAHalfWrittenRecordAndPicksItUpWhenItLands — in shared mode an
// incomplete tail is the ordinary case, not damage, so Tail must return without
// an error and without advancing past it.
func TestTailStopsAtAHalfWrittenRecordAndPicksItUpWhenItLands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.wal")
	w := openSharedAt(t, path)
	if _, err := w.AppendSync([]byte("whole")); err != nil {
		t.Fatal(err)
	}
	got, next := tailAll(t, w, 0)
	if len(got) != 1 {
		t.Fatalf("tail = %v, want [whole]", got)
	}

	// Frame a record and let only its header reach the file.
	payload := []byte("second-half-still-in-flight")
	rec := make([]byte, recHeader+len(payload))
	binary.BigEndian.PutUint32(rec[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(rec[4:8], crc32.ChecksumIEEE(payload))
	copy(rec[recHeader:], payload)
	appendRaw(t, path, rec[:recHeader])

	stalled, stalledAt := tailAll(t, w, next)
	if len(stalled) != 0 {
		t.Fatalf("tail delivered %v from a record whose payload has not landed", stalled)
	}
	if stalledAt != next {
		t.Fatalf("tail advanced to %d over an incomplete record, want it to hold at %d", stalledAt, next)
	}

	appendRaw(t, path, rec[recHeader:]) // the rest of the write lands
	landed, _ := tailAll(t, w, stalledAt)
	if len(landed) != 1 || landed[0] != string(payload) {
		t.Fatalf("tail = %v after the record completed, want it delivered", landed)
	}
}

// ── writing ─────────────────────────────────────────────────────────────────

// TestSharedAppendReportsNoOffset — with O_APPEND the writer is not told where
// its record went, and on Windows the handle's own pointer counts only its own
// writes. Returning -1 is the honest answer; returning a number would be a lie
// that works on Linux and corrupts on Windows.
func TestSharedAppendReportsNoOffset(t *testing.T) {
	w := openSharedAt(t, filepath.Join(t.TempDir(), "stream.wal"))
	off, err := w.Append([]byte("x"))
	if err != nil {
		t.Fatal(err)
	}
	if off != -1 {
		t.Fatalf("Append returned offset %d in shared mode, want -1", off)
	}
	off, err = w.AppendSync([]byte("y"))
	if err != nil {
		t.Fatal(err)
	}
	if off != -1 {
		t.Fatalf("AppendSync returned offset %d in shared mode, want -1", off)
	}
}

func TestSharedAppendStillRefusesEmptyAndOversizeRecords(t *testing.T) {
	w := openSharedAt(t, filepath.Join(t.TempDir(), "stream.wal"))
	if _, err := w.Append(nil); err != ErrRecordTooLarge {
		t.Fatalf("Append(nil) = %v, want ErrRecordTooLarge", err)
	}
	if _, err := w.Append(make([]byte, MaxRecord+1)); err != ErrRecordTooLarge {
		t.Fatalf("Append(oversize) = %v, want ErrRecordTooLarge", err)
	}
}

// TestConcurrentOpenSharedWritesTheHeaderExactlyOnce — two containers booting
// together both find no file. Without O_EXCL both write the magic and the
// second copy sits where the first record belongs.
func TestConcurrentOpenSharedWritesTheHeaderExactlyOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.wal")
	const openers = 8

	var wg sync.WaitGroup
	errs := make([]error, openers)
	logs := make([]*WAL, openers)
	for i := 0; i < openers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			logs[i], errs[i] = OpenShared(path)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("opener %d: %v", i, err)
		}
		defer logs[i].Close()
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if st.Size() != headerSize {
		t.Fatalf("file is %d bytes after %d concurrent opens, want exactly %d — "+
			"more than one process wrote the header", st.Size(), openers, headerSize)
	}
}

// TestOpenSharedTruncatesATailThatNeverCompletes — settling is a grace period,
// not a promise. A tail that is still short after tornSettleAttempts is a crash,
// and it is repaired and reported exactly as the single-writer path does it.
func TestOpenSharedTruncatesATailThatNeverCompletes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stream.wal")
	w := openSharedAt(t, path)
	if _, err := w.AppendSync([]byte("intact")); err != nil {
		t.Fatal(err)
	}
	good := w.Size()
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	appendRaw(t, path, []byte{0, 0, 0})

	again := openSharedAt(t, path)
	torn, at := again.TornTailTruncated()
	if !torn || at != good {
		t.Fatalf("TornTailTruncated() = (%v, %d), want (true, %d)", torn, at, good)
	}
	got, _ := tailAll(t, again, 0)
	if len(got) != 1 || got[0] != "intact" {
		t.Fatalf("after repair: %v, want [intact]", got)
	}
}

// ── two real OS processes ───────────────────────────────────────────────────

const helperEnv = "KAVACH_WAL_APPEND_HELPER"

// TestSharedAppendHelperProcess is not a test. It is the second process:
// go test re-executes this binary with -test.run pointing here, and the env var
// carries "path;tag;count". Without the env var it skips, which is what happens
// on every ordinary run.
func TestSharedAppendHelperProcess(t *testing.T) {
	spec := os.Getenv(helperEnv)
	if spec == "" {
		t.Skip("helper process for TestTwoRealProcessesAppendToOneSharedLog")
	}
	parts := strings.Split(spec, ";")
	if len(parts) != 3 {
		t.Fatalf("helper spec %q, want path;tag;count", spec)
	}
	count, err := strconv.Atoi(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	w, err := OpenShared(parts[0])
	if err != nil {
		t.Fatalf("helper OpenShared: %v", err)
	}
	for i := 0; i < count; i++ {
		if _, err := w.AppendSync([]byte(fmt.Sprintf("%s-%03d", parts[1], i))); err != nil {
			t.Fatalf("helper append %d: %v", i, err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("helper close: %v", err)
	}
}

// TestTwoRealProcessesAppendToOneSharedLog is the claim D-027 could not make.
// Two operating-system processes, one file, appending at the same time — the
// compose topology, with the container boundary replaced by a process boundary
// rather than by an argument.
//
// Every record from both must be present and intact. The failure this replaces
// is not "some are late": before OpenShared, the second writer's records landed
// on top of the first's, and reopening the directory found one survivor.
func TestTwoRealProcessesAppendToOneSharedLog(t *testing.T) {
	const perWriter = 200
	path := filepath.Join(t.TempDir(), "stream.wal")

	helper := exec.Command(os.Args[0], "-test.run=^TestSharedAppendHelperProcess$")
	helper.Env = append(os.Environ(), fmt.Sprintf("%s=%s;child;%d", helperEnv, path, perWriter))
	var helperOut strings.Builder
	helper.Stdout, helper.Stderr = &helperOut, &helperOut
	if err := helper.Start(); err != nil {
		// Windows Application Control refuses to launch a binary out of the
		// go-build temp tree (see CLAUDE.md — the same policy that blocks
		// sos-ingest's test binary). That is the OS, not this code: the test
		// passes when the binary has a stable path.
		//
		//	go test -c -o .gotmp/wal.test.exe ./internal/wal/
		//	./.gotmp/wal.test.exe -test.run=TestTwoRealProcessesAppendToOneSharedLog
		//
		// Skipped rather than failed ONLY for that one refusal, and only here:
		// on Linux, and therefore in CI, this test runs.
		if strings.Contains(err.Error(), "Application Control policy") {
			t.Skipf("cannot re-exec the test binary on this machine: %v", err)
		}
		t.Fatalf("start helper: %v", err)
	}

	// The parent writes its own records into the same file at the same time.
	w, err := OpenShared(path)
	if err != nil {
		t.Fatalf("parent OpenShared: %v", err)
	}
	for i := 0; i < perWriter; i++ {
		if _, err := w.AppendSync([]byte(fmt.Sprintf("parent-%03d", i))); err != nil {
			t.Fatalf("parent append %d: %v", i, err)
		}
	}

	if err := helper.Wait(); err != nil {
		t.Fatalf("helper process failed: %v\n%s", err, helperOut.String())
	}

	got, _ := tailAll(t, w, 0)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	counts := map[string]int{}
	for _, p := range got {
		if i := strings.LastIndex(p, "-"); i > 0 {
			counts[p[:i]]++
		}
	}
	if counts["parent"] != perWriter || counts["child"] != perWriter {
		t.Fatalf("read %d records: parent=%d child=%d, want %d each — "+
			"a record written by one process was lost or overwritten by the other",
			len(got), counts["parent"], counts["child"], perWriter)
	}
}
