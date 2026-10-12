package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// buildFakeExe writes a minimal MZ-headed file of exactly size bytes and
// returns its path and sha256 hex digest.
func buildFakeExe(t *testing.T, dir, name string, size int) (string, string) {
	t.Helper()
	if size < 2 {
		t.Fatalf("size must hold the MZ header, got %d", size)
	}
	buf := make([]byte, size)
	buf[0] = 0x4D
	buf[1] = 0x5A
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	sum := sha256.Sum256(buf)
	return path, hex.EncodeToString(sum[:])
}

func TestValidateInstallerFinalExe(t *testing.T) {
	dir := t.TempDir()
	path, sha := buildFakeExe(t, dir, "MatricaRMZ-Setup-3.73.0.exe", 1024)
	if err := validateInstaller(path, 1024, sha); err != nil {
		t.Fatalf("valid installer rejected: %v", err)
	}
}

func TestValidateInstallerStagingPartName(t *testing.T) {
	// M152: downloadInstaller stages the download as `<final>.exe.part` and
	// validates BEFORE rename — the staging name must pass the .exe check
	// while the bytes are read from the staging path itself.
	dir := t.TempDir()
	path, sha := buildFakeExe(t, dir, "matricarmz-watchdog-3.73.0.exe.part", 1024)
	if err := validateInstaller(path, 1024, sha); err != nil {
		t.Fatalf("staged download rejected: %v", err)
	}
}

func TestValidateInstallerRejectsNonExe(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"installer.txt", "installer.part", "installer.exe.bak", ".part"} {
		path, sha := buildFakeExe(t, dir, name, 64)
		if err := validateInstaller(path, 64, sha); err == nil {
			t.Fatalf("%s accepted, want rejection", name)
		} else if !strings.Contains(err.Error(), "not an .exe") {
			t.Fatalf("%s rejected with unexpected error: %v", name, err)
		}
	}
}

func TestValidateInstallerContentChecks(t *testing.T) {
	dir := t.TempDir()

	path, sha := buildFakeExe(t, dir, "good-3.73.0.exe.part", 512)
	if err := validateInstaller(path, 999, sha); err == nil {
		t.Fatal("size mismatch accepted")
	}
	if err := validateInstaller(path, 512, strings.Repeat("0", 64)); err == nil {
		t.Fatal("sha mismatch accepted")
	}

	empty := filepath.Join(dir, "empty-1.0.0.exe")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateInstaller(empty, 0, ""); err == nil {
		t.Fatal("empty installer accepted")
	}

	plain := filepath.Join(dir, "plain-1.0.0.exe")
	if err := os.WriteFile(plain, []byte("not a PE file at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateInstaller(plain, 0, ""); err == nil {
		t.Fatal("non-MZ file accepted")
	}
}

func TestBackoffForGrowsAndCaps(t *testing.T) {
	if got := backoffFor(1); got != 30*time.Minute {
		t.Fatalf("backoffFor(1) = %v, want 30m", got)
	}
	if got := backoffFor(2); got != time.Hour {
		t.Fatalf("backoffFor(2) = %v, want 1h", got)
	}
	if got := backoffFor(100); got != 24*time.Hour {
		t.Fatalf("backoffFor(100) = %v, want cap 24h", got)
	}
}
