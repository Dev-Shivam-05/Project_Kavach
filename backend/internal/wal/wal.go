// Package wal is the append-only write-ahead log that makes an SOS durable
// BEFORE the device is told "help is on the way" (§2.5.1 step 2).
//
// ADR-002: sos-ingest owns its durability. It does not depend on the control
// plane, on Postgres, or on anything that a bad deploy can take away. If the
// process dies one instruction after AppendSync returns, the incident survives
// and is replayed at boot. That is the entire justification for this file.
//
// Record framing:
//
//	file header : 8 bytes  "KVWAL" 0x00 0x01 '\n'
//	record      : u32 length (big-endian) | u32 CRC32(payload) | payload
//
// A crash mid-write leaves a torn tail: a short header, a short payload, or a
// payload whose CRC does not match. Open() truncates exactly that tail and says
// so, because silently serving half a record is how a log stops being a log.
//
// Two modes, and the difference is who else may hold the file (D-027):
//
//	Open       — one writer, this process. sos.wal. Records are placed with
//	             WriteAt at an offset this instance tracks, and Replay's window
//	             is that offset. Unchanged since ADR-002.
//	OpenShared — many writers, many processes. stream.wal under internal/bus.
//	             Records are placed by the kernel with O_APPEND, one whole
//	             record per Write, and readers reach them with Tail, which
//	             re-stats the file instead of trusting a size fixed at boot.
package wal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	headerSize = 8
	recHeader  = 8
	// MaxRecord bounds a single record. The ingest path caps bodies at 8 KB; 1 MB
	// leaves room for batched replay records without letting a corrupt length
	// field make us allocate a gigabyte.
	MaxRecord = 1 << 20
)

var magic = [headerSize]byte{'K', 'V', 'W', 'A', 'L', 0x00, 0x01, '\n'}

// ErrRecordTooLarge is returned rather than silently splitting a record.
var ErrRecordTooLarge = errors.New("wal: record exceeds MaxRecord")

// ErrClosed is returned by every method after Close.
var ErrClosed = errors.New("wal: closed")

// Settling a torn tail in shared mode. A tail that is short right now is more
// often another process midway through a Write than a crash, so the repair
// looks again before it truncates. 20 × 5 ms is two orders of magnitude longer
// than a local append and still inside a container's start_period.
const (
	tornSettleAttempts = 20
	tornSettleDelay    = 5 * time.Millisecond
)

// WAL is safe for concurrent use.
type WAL struct {
	mu       sync.Mutex
	f        *os.File
	path     string
	shared   bool
	size     int64
	count    uint64
	torn     bool
	tornAt   int64
	unsynced bool
	closed   bool
}

// Open opens or creates the log for a single writer — this process — repairing
// a torn tail if one is present. This is sos.wal (ADR-002) and its behaviour is
// unchanged: writes are placed at an offset this instance tracks, and Replay
// reads up to that offset.
func Open(path string) (*WAL, error) { return open(path, false) }

// OpenShared opens the log for MULTI-PROCESS use: many writers, many readers,
// one file (D-027).
//
// Two things differ, and both are the whole point.
//
//	Writing — the handle carries O_APPEND, so the kernel places each record at
//	the current end of the file under its own lock. One Write per whole record
//	is therefore atomic against every other process appending to the same file,
//	with no advisory lock and no syscall behind a build tag. What it costs is
//	the byte offset: with O_APPEND the writer cannot be told where its record
//	landed, so appendLocked returns -1 in this mode rather than a number that is
//	wrong on Windows. Nothing reads it.
//
//	Reading — Replay's window (w.size) is useless here, because it does not
//	include what anybody else appended. Tail re-stats the file on every call and
//	is the only correct reader in this mode.
//
// The header is written by whoever wins O_EXCL, exactly once. Everyone else
// waits for it rather than writing a second copy over the first record.
func OpenShared(path string) (*WAL, error) { return open(path, true) }

func open(path string, shared bool) (*WAL, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if shared {
		if err := createShared(path); err != nil {
			return nil, err
		}
	}
	flags := os.O_RDWR | os.O_CREATE
	if shared {
		flags |= os.O_APPEND
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return nil, err
	}
	w := &WAL{f: f, path: path, shared: shared}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	w.size = st.Size()

	if shared && w.size < headerSize {
		// createShared lost the O_EXCL race, so another process is writing the
		// header right now. Wait for it. Writing our own would put a second magic
		// where the first record belongs — and in append mode we cannot take it
		// back, because we cannot address offset 0.
		if err := w.awaitHeader(); err != nil {
			_ = f.Close()
			return nil, err
		}
	}

	if w.size < headerSize {
		// Either brand new, or the process died while writing the header itself.
		if err := f.Truncate(0); err != nil {
			_ = f.Close()
			return nil, err
		}
		if _, err := f.WriteAt(magic[:], 0); err != nil {
			_ = f.Close()
			return nil, err
		}
		if err := f.Sync(); err != nil {
			_ = f.Close()
			return nil, err
		}
		w.size = headerSize
		syncDir(path)
	} else {
		var got [headerSize]byte
		if _, err := f.ReadAt(got[:], 0); err != nil {
			_ = f.Close()
			return nil, err
		}
		if got != magic {
			_ = f.Close()
			return nil, fmt.Errorf("wal: %s is not a kavach WAL", path)
		}
	}

	if err := w.scan(); err != nil {
		_ = f.Close()
		return nil, err
	}
	return w, nil
}

// createShared writes the file header exactly once, whoever gets there first.
// Two containers booting together both see a file that does not exist yet; only
// the one that wins O_EXCL creates it. os.ErrExist is the ordinary answer.
func createShared(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		return err
	}
	_, werr := f.Write(magic[:])
	if werr == nil {
		werr = f.Sync()
	}
	cerr := f.Close()
	if werr != nil {
		return werr
	}
	if cerr != nil {
		return cerr
	}
	syncDir(path)
	return nil
}

// awaitHeader blocks until the process that won O_EXCL has written the magic.
func (w *WAL) awaitHeader() error {
	for attempt := 0; attempt < tornSettleAttempts; attempt++ {
		time.Sleep(tornSettleDelay)
		st, err := w.f.Stat()
		if err != nil {
			return err
		}
		if st.Size() >= headerSize {
			w.size = st.Size()
			return nil
		}
	}
	return fmt.Errorf("wal: %s has no header after %v; the process that created it did not finish",
		w.path, time.Duration(tornSettleAttempts)*tornSettleDelay)
}

// scan walks the log, counting intact records and truncating at the first one
// that is not intact. Everything after a damaged record is unreachable anyway —
// the framing is gone — so truncation loses nothing that could have been read.
//
// In shared mode a short tail is usually not damage at all — it is another
// process midway through appending — so the walk is repeated until the tail
// settles. Truncation is the last resort, and it is still a resort: a writer
// that stalls for longer than tornSettleAttempts × tornSettleDelay between
// issuing a Write and the bytes landing loses that record. Every other record
// in the file is untouched either way.
func (w *WAL) scan() error {
	for attempt := 0; ; attempt++ {
		w.torn, w.tornAt = false, 0
		if err := w.walk(); err != nil {
			return err
		}
		if !w.torn || !w.shared || attempt >= tornSettleAttempts {
			break
		}
		time.Sleep(tornSettleDelay)
		st, err := w.f.Stat()
		if err != nil {
			return err
		}
		if st.Size() > w.size {
			w.size = st.Size()
		}
	}
	if w.torn {
		if err := w.repairTo(w.tornAt); err != nil {
			return err
		}
		w.size = w.tornAt
	}
	if _, err := w.f.Seek(w.size, io.SeekStart); err != nil {
		return err
	}
	return nil
}

// repairTo cuts the file back to the last intact record.
//
// In shared mode it cannot use w.f: Windows grants an O_APPEND handle
// FILE_APPEND_DATA *without* FILE_WRITE_DATA, so SetEndOfFile through it fails
// with "Access is denied". A second handle with ordinary write access does the
// repair, and our append handle keeps working afterwards because the kernel
// positions every append at whatever the end of the file now is.
func (w *WAL) repairTo(size int64) error {
	if !w.shared {
		if err := w.f.Truncate(size); err != nil {
			return err
		}
		return w.f.Sync()
	}
	f, err := os.OpenFile(w.path, os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if err := f.Truncate(size); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}

// walk counts intact records up to w.size and records where the framing stops.
// It changes nothing on disk.
func (w *WAL) walk() error {
	off := int64(headerSize)
	var count uint64
	hdr := make([]byte, recHeader)
	for {
		if off+recHeader > w.size {
			if off != w.size {
				w.torn, w.tornAt = true, off
			}
			break
		}
		if _, err := w.f.ReadAt(hdr, off); err != nil {
			w.torn, w.tornAt = true, off
			break
		}
		n := binary.BigEndian.Uint32(hdr[0:4])
		sum := binary.BigEndian.Uint32(hdr[4:8])
		if n == 0 || n > MaxRecord || off+recHeader+int64(n) > w.size {
			w.torn, w.tornAt = true, off
			break
		}
		buf := make([]byte, n)
		if _, err := w.f.ReadAt(buf, off+recHeader); err != nil {
			w.torn, w.tornAt = true, off
			break
		}
		if crc32.ChecksumIEEE(buf) != sum {
			w.torn, w.tornAt = true, off
			break
		}
		off += recHeader + int64(n)
		count++
	}
	if !w.shared {
		w.count = count
	}
	// In shared mode the count of records in the file is not this instance's
	// business — another process is adding to it. Count() there means "records
	// this instance has read", and Tail owns it.
	return nil
}

func (w *WAL) appendLocked(payload []byte) (int64, error) {
	if w.closed {
		return 0, ErrClosed
	}
	if len(payload) == 0 || len(payload) > MaxRecord {
		return 0, ErrRecordTooLarge
	}
	rec := make([]byte, recHeader+len(payload))
	binary.BigEndian.PutUint32(rec[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(rec[4:8], crc32.ChecksumIEEE(payload))
	copy(rec[recHeader:], payload)

	if w.shared {
		// O_APPEND: the kernel places this record at the current end of file under
		// its own lock, so a whole record in ONE Write cannot interleave with, or
		// land on top of, a record another process is appending. That is what
		// makes stream.wal a seam instead of four private logs sharing a filename.
		//
		// The offset is deliberately not returned. On Windows the handle's own
		// pointer counts only this process's writes, so any number we computed
		// here would be a lie on the platform the tests run on. Neither bus call
		// site reads it; Tail hands out the true offsets.
		if _, err := w.f.Write(rec); err != nil {
			return 0, err
		}
		w.unsynced = true
		return -1, nil
	}

	off := w.size
	if _, err := w.f.WriteAt(rec, off); err != nil {
		// A partial write leaves a torn tail that the next Open repairs; the
		// in-memory size is deliberately NOT advanced so the next append
		// overwrites the damage.
		return 0, err
	}
	w.size += int64(len(rec))
	w.count++
	w.unsynced = true
	return off, nil
}

// AppendSync writes the record and fsyncs BEFORE returning. Nothing on the
// request path may acknowledge an incident until this has returned nil.
func (w *WAL) AppendSync(payload []byte) (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	off, err := w.appendLocked(payload)
	if err != nil {
		return 0, err
	}
	if err := w.f.Sync(); err != nil {
		return off, err
	}
	w.unsynced = false
	return off, nil
}

// Append writes without fsync. Only for streams whose durability is backed by
// another log that IS fsynced (the bus), never for the ingest path.
func (w *WAL) Append(payload []byte) (int64, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.appendLocked(payload)
}

// Sync flushes anything written by Append.
func (w *WAL) Sync() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return ErrClosed
	}
	if !w.unsynced {
		return nil
	}
	if err := w.f.Sync(); err != nil {
		return err
	}
	w.unsynced = false
	return nil
}

// endLocked reports how far this instance may read. In single-writer mode that
// is the size it has been tracking since Open. In shared mode it is whatever
// the file is right now, because everything another process appended arrived
// without passing through this instance at all. Size never shrinks here: a
// truncation racing a Stat must not make a record we already handed out
// unreadable.
func (w *WAL) endLocked() (int64, error) {
	if !w.shared {
		return w.size, nil
	}
	st, err := w.f.Stat()
	if err != nil {
		return w.size, err
	}
	if st.Size() > w.size {
		w.size = st.Size()
	}
	return w.size, nil
}

// Tail reads every intact record between the byte offset `from` and the current
// end of the file, and returns the offset just past the last one. Pass that
// offset back on the next call; `from` below headerSize starts at the first
// record. The callback receives each record's true offset.
//
// This is the reader half of multi-process operation (D-027). It stops — with
// no error — at the first record that is not yet whole, because in shared mode
// that is the ordinary case: a writer is midway through a Write and the rest of
// the record is about to arrive. The caller retries on its next tick and picks
// up from the same offset.
func (w *WAL) Tail(from int64, fn func(offset int64, payload []byte) error) (int64, error) {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return from, ErrClosed
	}
	f := w.f
	end, err := w.endLocked()
	w.mu.Unlock()
	if err != nil {
		return from, err
	}

	off := from
	if off < headerSize {
		off = headerSize
	}
	var read uint64
	hdr := make([]byte, recHeader)
	for off+recHeader <= end {
		if _, err := f.ReadAt(hdr, off); err != nil {
			break
		}
		n := binary.BigEndian.Uint32(hdr[0:4])
		sum := binary.BigEndian.Uint32(hdr[4:8])
		if n == 0 || n > MaxRecord || off+recHeader+int64(n) > end {
			break // not yet whole
		}
		buf := make([]byte, n)
		if _, err := f.ReadAt(buf, off+recHeader); err != nil {
			break
		}
		if crc32.ChecksumIEEE(buf) != sum {
			break // the payload has not fully landed, or this record is damaged
		}
		if err := fn(off, buf); err != nil {
			return off, err
		}
		off += recHeader + int64(n)
		read++
	}
	if read > 0 && w.shared {
		w.mu.Lock()
		w.count += read
		w.mu.Unlock()
	}
	return off, nil
}

// Replay walks every intact record in write order. The callback receives a
// 1-based sequence number and the record offset; returning an error stops the
// walk and is returned to the caller.
func (w *WAL) Replay(fn func(seq uint64, offset int64, payload []byte) error) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return ErrClosed
	}
	end, err := w.endLocked()
	f := w.f
	w.mu.Unlock()
	if err != nil {
		return err
	}

	off := int64(headerSize)
	var seq uint64
	hdr := make([]byte, recHeader)
	for off+recHeader <= end {
		if _, err := f.ReadAt(hdr, off); err != nil {
			return err
		}
		n := binary.BigEndian.Uint32(hdr[0:4])
		sum := binary.BigEndian.Uint32(hdr[4:8])
		if n == 0 || n > MaxRecord || off+recHeader+int64(n) > end {
			return nil // torn tail written after our snapshot; nothing more to read
		}
		buf := make([]byte, n)
		if _, err := f.ReadAt(buf, off+recHeader); err != nil {
			return err
		}
		if crc32.ChecksumIEEE(buf) != sum {
			return nil
		}
		seq++
		if err := fn(seq, off, buf); err != nil {
			return err
		}
		off += recHeader + int64(n)
	}
	return nil
}

// ReadAt returns the single record stored at offset — as reported by Append in
// single-writer mode, or by Tail in shared mode, where Append reports nothing.
func (w *WAL) ReadAt(offset int64) ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, ErrClosed
	}
	end, err := w.endLocked()
	if err != nil {
		return nil, err
	}
	if offset < headerSize || offset+recHeader > end {
		return nil, io.ErrUnexpectedEOF
	}
	hdr := make([]byte, recHeader)
	if _, err := w.f.ReadAt(hdr, offset); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[0:4])
	if n == 0 || n > MaxRecord || offset+recHeader+int64(n) > end {
		return nil, io.ErrUnexpectedEOF
	}
	buf := make([]byte, n)
	if _, err := w.f.ReadAt(buf, offset+recHeader); err != nil {
		return nil, err
	}
	if crc32.ChecksumIEEE(buf) != binary.BigEndian.Uint32(hdr[4:8]) {
		return nil, errors.New("wal: checksum mismatch")
	}
	return buf, nil
}

func (w *WAL) Count() uint64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.count
}

func (w *WAL) Size() int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	size, _ := w.endLocked()
	return size
}

func (w *WAL) Path() string { return w.path }

// TornTailTruncated reports whether Open repaired a crash-torn tail. sos-ingest
// surfaces this on /healthz: a silent repair is an operational event.
func (w *WAL) TornTailTruncated() (bool, int64) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.torn, w.tornAt
}

func (w *WAL) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil
	}
	w.closed = true
	if w.unsynced {
		_ = w.f.Sync()
	}
	return w.f.Close()
}

// syncDir makes the newly created file's directory entry durable too. Best
// effort: Windows cannot fsync a directory handle, and failing to do so is not
// a reason to refuse to accept an SOS.
func syncDir(path string) {
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
