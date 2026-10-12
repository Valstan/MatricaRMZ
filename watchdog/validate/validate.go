// Package validate holds the watchdog's OS-independent installer checks.
//
// It lives in a subpackage (not package main) so `go test` runs on the Linux
// CI host: the main package needs GOOS=windows to compile (windows-only
// syscalls), while this file is pure stdlib and portable. M152's regression
// cover gates here; the windows build itself is covered by `go vet` + `go
// build` with GOOS=windows.
package validate

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// ValidateInstaller mirrors the app's validateInstallerBeforeLaunch: .exe
// size match (when known), an MZ PE header, and a sha256 match (when known).
// The name check tolerates the download staging suffix: downloadInstaller
// fetches into `<final>.exe.part` and validates BEFORE rename, so the suffix
// is judged on the final name, the bytes on the passed path. (M152: judging
// the staging path itself rejected every download with "not an .exe".)
func ValidateInstaller(path string, expectedSize int64, expectedSha string) error {
	name := strings.ToLower(path)
	name = strings.TrimSuffix(name, ".part")
	if !strings.HasSuffix(name, ".exe") {
		return fmt.Errorf("not an .exe: %s", path)
	}
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !st.Mode().IsRegular() || st.Size() == 0 {
		return fmt.Errorf("installer empty or not a file")
	}
	if expectedSize > 0 && st.Size() != expectedSize {
		return fmt.Errorf("size mismatch: got=%d want=%d", st.Size(), expectedSize)
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	head := make([]byte, 2)
	if _, err := io.ReadFull(f, head); err != nil {
		return fmt.Errorf("read header: %w", err)
	}
	if head[0] != 0x4D || head[1] != 0x5A { // "MZ"
		return fmt.Errorf("missing MZ header")
	}
	if strings.TrimSpace(expectedSha) != "" {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return err
		}
		got := hex.EncodeToString(h.Sum(nil))
		if !strings.EqualFold(got, strings.TrimSpace(expectedSha)) {
			return fmt.Errorf("sha256 mismatch")
		}
	}
	return nil
}

// BackoffFor: 30m after the first failure, doubling per failure, capped at 24h.
func BackoffFor(failCount int) time.Duration {
	d := 30 * time.Minute
	for i := 1; i < failCount && d < 24*time.Hour; i++ {
		d *= 2
	}
	if d > 24*time.Hour {
		d = 24 * time.Hour
	}
	return d
}
