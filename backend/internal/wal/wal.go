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

// WAL is safe for concurrent use.
type WAL struct {
	mu       sync.Mutex
	f        *os.File
	path     string
	size     int64
	count    uint64
	torn     bool
	tornAt   int64
	unsynced bool
	closed   bool
}

// Open opens or creates the log, repairing a torn tail if one is present.
func Open(path string) (*WAL, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	w := &WAL{f: f, path: path}
	st, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	w.size = st.Size()

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

// scan walks the log, counting intact records and truncating at the first one
// that is not intact. Everything after a damaged record is unreachable anyway —
// the framing is gone — so truncation loses nothing that could have been read.
func (w *WAL) scan() error {
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
	w.count = count
	if w.torn {
		if err := w.f.Truncate(w.tornAt); err != nil {
			return err
		}
		if err := w.f.Sync(); err != nil {
			return err
		}
		w.size = w.tornAt
	}
	if _, err := w.f.Seek(w.size, io.SeekStart); err != nil {
		return err
	}
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

// Replay walks every intact record in write order. The callback receives a
// 1-based sequence number and the record offset; returning an error stops the
// walk and is returned to the caller.
func (w *WAL) Replay(fn func(seq uint64, offset int64, payload []byte) error) error {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return ErrClosed
	}
	end := w.size
	f := w.f
	w.mu.Unlock()

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

// ReadAt returns the single record stored at offset, as reported by Append.
func (w *WAL) ReadAt(offset int64) ([]byte, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return nil, ErrClosed
	}
	if offset < headerSize || offset+recHeader > w.size {
		return nil, io.ErrUnexpectedEOF
	}
	hdr := make([]byte, recHeader)
	if _, err := w.f.ReadAt(hdr, offset); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[0:4])
	if n == 0 || n > MaxRecord || offset+recHeader+int64(n) > w.size {
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
	return w.size
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
