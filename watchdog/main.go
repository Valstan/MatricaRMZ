// MatricaRMZ watchdog — a tiny external recovery agent for the Electron client.
//
// Why it exists: the NSIS one-click installer wipes `%LOCALAPPDATA%\Programs\
// MatricaRMZ` before reinstalling. If the installer dies between the wipe and
// the reinstall, the app and its shortcuts vanish and the in-app updater (which
// lives inside the now-missing app) cannot help. This binary runs OUTSIDE the
// app — launched by a Windows Scheduled Task (at logon + every ~15 min) — does
// one pass and exits. It is single-pass (not resident) to keep the memory and
// antivirus footprint near zero.
//
// One pass (the "ladder"):
//   1. read the app handshake (%APPDATA%\MatricaRMZ\watchdog.json)
//   2. poll the server for an owner-issued `reinstall` command
//   3. if the app exe is present and no command is pending -> exit (do nothing)
//   4. otherwise find a valid installer: pending-update.json -> updates dir ->
//      download from the server
//   5. run it silently (`/S`), wait, re-check presence
//   6. report the outcome (recovered / failed) to the server, which records a
//      critical event the owner sees; ack the command if one was pending
//
// Pure stdlib on purpose: no third-party deps means a trivial CI build and a
// small static exe. The watchdog NEVER touches a healthy app (it acts only when
// the exe is missing or the owner explicitly commanded a reinstall), so it
// cannot race the normal in-app updater.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type handshake struct {
	ClientID       string `json:"clientId"`
	APIBaseURL     string `json:"apiBaseUrl"`
	Version        string `json:"version"`
	AppExePath     string `json:"appExePath"`
	UserDataDir    string `json:"userDataDir"`
	UpdatesRootDir string `json:"updatesRootDir"`
	UpdaterLogPath string `json:"updaterLogPath"`
	AppLogPath     string `json:"appLogPath"`
	UpdatedAtMs    int64  `json:"updatedAtMs"`
}

type pendingUpdate struct {
	Version      string `json:"version"`
	InstallerPath string `json:"installerPath"`
	ExpectedSize *int64 `json:"expectedSize"`
	ExpectedSha  string `json:"expectedSha"`
	DownloadURL  string `json:"downloadUrl"`
}

type latestMeta struct {
	OK       bool   `json:"ok"`
	Version  string `json:"version"`
	FileName string `json:"fileName"`
	Size     int64  `json:"size"`
	Sha256   string `json:"sha256"`
}

type clientSettingsResp struct {
	OK       bool `json:"ok"`
	Settings struct {
		SyncRequestID   string `json:"syncRequestId"`
		SyncRequestType string `json:"syncRequestType"`
	} `json:"settings"`
}

const (
	standardInstallExe = `Programs\MatricaRMZ\MatricaRMZ.exe` // under %LOCALAPPDATA%
	httpTimeout        = 30 * time.Second
	downloadTimeout    = 5 * time.Minute
)

var httpClient = &http.Client{Timeout: httpTimeout}

func main() {
	logf("watchdog pass start")
	hs, err := readHandshake()
	if err != nil {
		// No handshake means the app has never run on this account, so there is
		// nothing this user's watchdog can or should recover.
		logf("no usable handshake (%v) — nothing to do", err)
		return
	}

	forced, reqID := checkReinstallCommand(hs)
	present := appPresent(hs)

	if present && !forced {
		logf("app present and no pending command — healthy, exiting")
		return
	}

	reason := "app missing"
	if forced {
		reason = "owner reinstall command"
	}
	logf("recovery needed: %s (clientId=%s)", reason, hs.ClientID)

	// Respect the in-app updater's lock: if a normal update is mid-flight, defer
	// to the next pass rather than launching a second installer over it.
	if updaterInProgress(hs) {
		logf("update.lock is fresh — normal updater in progress, deferring to next pass")
		return
	}

	installer, src, err := findInstaller(hs)
	if err != nil {
		logf("no valid installer found: %v", err)
		report(hs, "failed", fmt.Sprintf("no valid installer: %v", err), 0)
		if forced {
			ackCommand(hs, reqID, "error", fmt.Sprintf("no valid installer: %v", err))
		}
		return
	}
	logf("using installer %s (source=%s)", installer, src)

	exitCode, runErr := runSilentInstaller(installer)
	time.Sleep(3 * time.Second)

	if appPresent(hs) {
		logf("recovery succeeded (installer exit=%d)", exitCode)
		report(hs, "recovered", fmt.Sprintf("installer=%s source=%s exit=%d", filepath.Base(installer), src, exitCode), exitCode)
		if forced {
			ackCommand(hs, reqID, "ok", "")
		}
		return
	}

	detail := fmt.Sprintf("app still missing after install; exit=%d; runErr=%v; %s", exitCode, runErr, logTails(hs))
	logf("recovery FAILED: %s", detail)
	report(hs, "failed", detail, exitCode)
	if forced {
		ackCommand(hs, reqID, "error", "app still missing after install")
	}
}

// --- handshake -------------------------------------------------------------

func handshakePath() string {
	return filepath.Join(os.Getenv("APPDATA"), "MatricaRMZ", "watchdog.json")
}

func readHandshake() (*handshake, error) {
	raw, err := os.ReadFile(handshakePath())
	if err != nil {
		return nil, err
	}
	var hs handshake
	if err := json.Unmarshal(raw, &hs); err != nil {
		return nil, err
	}
	if strings.TrimSpace(hs.ClientID) == "" || strings.TrimSpace(hs.APIBaseURL) == "" {
		return nil, fmt.Errorf("handshake missing clientId/apiBaseUrl")
	}
	hs.APIBaseURL = strings.TrimRight(strings.TrimSpace(hs.APIBaseURL), "/")
	return &hs, nil
}

// --- presence --------------------------------------------------------------

func appPresent(hs *handshake) bool {
	if isRegularFile(hs.AppExePath) {
		return true
	}
	// Fall back to the standard per-user install path in case the handshake's
	// recorded exe path is stale (e.g. a dev build wrote it).
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		if isRegularFile(filepath.Join(local, standardInstallExe)) {
			return true
		}
	}
	return false
}

// updaterInProgress mirrors the app's acquireUpdateLock staleness window (2h):
// a fresh update.lock means the in-app updater is actively installing.
func updaterInProgress(hs *handshake) bool {
	if hs.UpdatesRootDir == "" {
		return false
	}
	st, err := os.Stat(filepath.Join(hs.UpdatesRootDir, "update.lock"))
	if err != nil || !st.Mode().IsRegular() {
		return false
	}
	return time.Since(st.ModTime()) < 2*time.Hour
}

func isRegularFile(path string) bool {
	if strings.TrimSpace(path) == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular() && st.Size() > 0
}

// --- installer discovery + validation --------------------------------------

func findInstaller(hs *handshake) (path string, source string, err error) {
	// 1) pending-update.json staged by the app.
	if p, ok := installerFromPending(hs); ok {
		return p, "pending-update", nil
	}
	// 2) any valid *.exe already sitting in the updates dir (newest first).
	if p, ok := installerFromUpdatesDir(hs); ok {
		return p, "updates-dir", nil
	}
	// 3) download a fresh installer from the server.
	p, derr := downloadInstaller(hs)
	if derr != nil {
		return "", "", derr
	}
	return p, "download", nil
}

func installerFromPending(hs *handshake) (string, bool) {
	if hs.UpdatesRootDir == "" {
		return "", false
	}
	raw, err := os.ReadFile(filepath.Join(hs.UpdatesRootDir, "pending-update.json"))
	if err != nil {
		return "", false
	}
	var pu pendingUpdate
	if json.Unmarshal(raw, &pu) != nil || strings.TrimSpace(pu.InstallerPath) == "" {
		return "", false
	}
	var size int64
	if pu.ExpectedSize != nil {
		size = *pu.ExpectedSize
	}
	if validateInstaller(pu.InstallerPath, size, pu.ExpectedSha) == nil {
		return pu.InstallerPath, true
	}
	return "", false
}

func installerFromUpdatesDir(hs *handshake) (string, bool) {
	if hs.UpdatesRootDir == "" {
		return "", false
	}
	entries, err := os.ReadDir(hs.UpdatesRootDir)
	if err != nil {
		return "", false
	}
	type cand struct {
		path    string
		modTime time.Time
	}
	var cands []cand
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".exe") {
			continue
		}
		full := filepath.Join(hs.UpdatesRootDir, e.Name())
		info, ierr := e.Info()
		if ierr != nil {
			continue
		}
		cands = append(cands, cand{path: full, modTime: info.ModTime()})
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].modTime.After(cands[j].modTime) })
	for _, c := range cands {
		// No expected size/sha here — accept any well-formed PE executable.
		if validateInstaller(c.path, 0, "") == nil {
			return c.path, true
		}
	}
	return "", false
}

func downloadInstaller(hs *handshake) (string, error) {
	meta, err := fetchLatestMeta(hs.APIBaseURL)
	if err != nil {
		return "", fmt.Errorf("latest-meta: %w", err)
	}
	req, err := newGET(joinURL(hs.APIBaseURL, "/updates/file/"+url.PathEscape(meta.FileName)))
	if err != nil {
		return "", err
	}
	cl := &http.Client{Timeout: downloadTimeout}
	resp, err := cl.Do(req)
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	dst := filepath.Join(os.TempDir(), fmt.Sprintf("matricarmz-watchdog-%s.exe", meta.Version))
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		return "", fmt.Errorf("write installer: %w", err)
	}
	out.Close()
	if err := validateInstaller(dst, meta.Size, meta.Sha256); err != nil {
		_ = os.Remove(dst)
		return "", fmt.Errorf("downloaded installer invalid: %w", err)
	}
	return dst, nil
}

// validateInstaller mirrors the app's validateInstallerBeforeLaunch: .exe size
// match (when known), an MZ PE header, and a sha256 match (when known).
func validateInstaller(path string, expectedSize int64, expectedSha string) error {
	if !strings.HasSuffix(strings.ToLower(path), ".exe") {
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

func runSilentInstaller(path string) (int, error) {
	// electron-builder NSIS one-click installer: `/S` runs silently; per-user
	// install needs no UAC, so this works from the Scheduled Task's user context.
	cmd := exec.Command(path, "/S")
	err := cmd.Run()
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), err
		}
		return -1, err
	}
	return 0, nil
}

// --- server I/O ------------------------------------------------------------

func fetchLatestMeta(base string) (*latestMeta, error) {
	req, err := newGET(joinURL(base, "/updates/latest-meta"))
	if err != nil {
		return nil, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var m latestMeta
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, err
	}
	if !m.OK || strings.TrimSpace(m.FileName) == "" {
		return nil, fmt.Errorf("invalid latest-meta payload")
	}
	return &m, nil
}

func checkReinstallCommand(hs *handshake) (forced bool, requestID string) {
	q := url.Values{}
	q.Set("clientId", hs.ClientID)
	if hs.Version != "" {
		q.Set("version", hs.Version)
	}
	req, err := newGET(joinURL(hs.APIBaseURL, "/client/settings") + "?" + q.Encode())
	if err != nil {
		return false, ""
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, ""
	}
	var cs clientSettingsResp
	if err := json.NewDecoder(resp.Body).Decode(&cs); err != nil {
		return false, ""
	}
	if cs.OK && cs.Settings.SyncRequestType == "reinstall" && cs.Settings.SyncRequestID != "" {
		return true, cs.Settings.SyncRequestID
	}
	return false, ""
}

func ackCommand(hs *handshake, requestID, status, errMsg string) {
	body := map[string]any{
		"clientId":  hs.ClientID,
		"requestId": requestID,
		"status":    status,
		"error":     errMsg,
		"at":        time.Now().UnixMilli(),
	}
	postJSON(joinURL(hs.APIBaseURL, "/client/settings/sync-request/ack"), body)
}

func report(hs *handshake, kind, detail string, exitCode int) {
	body := map[string]any{
		"clientId": hs.ClientID,
		"kind":     kind,
		"version":  hs.Version,
		"detail":   truncate(detail, 4000),
		"exitCode": exitCode,
	}
	postJSON(joinURL(hs.APIBaseURL, "/client/watchdog/report"), body)
}

func postJSON(target string, body map[string]any) {
	raw, err := json.Marshal(body)
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		logf("postJSON %s failed: %v", target, err)
		return
	}
	resp.Body.Close()
}

func newGET(target string) (*http.Request, error) {
	return http.NewRequest(http.MethodGet, target, nil)
}

func joinURL(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}

// --- misc ------------------------------------------------------------------

// logTails returns the last few lines of the app and updater logs so a failure
// report carries the likely crash cause without inventing new diagnostics.
func logTails(hs *handshake) string {
	var b strings.Builder
	for _, p := range []string{hs.AppLogPath, hs.UpdaterLogPath} {
		if tail := tailFile(p, 20); tail != "" {
			fmt.Fprintf(&b, "\n--- %s ---\n%s", filepath.Base(p), tail)
		}
	}
	return truncate(b.String(), 8000)
}

func tailFile(path string, lines int) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	parts := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// logf appends to the file log (the authoritative record) and best-effort to
// stderr. The release build links with -H=windowsgui (GUI subsystem) so the
// Scheduled Task never flashes a console window at operators — stderr then has
// no console attached and the write is a harmless no-op; the file log remains.
func logf(format string, args ...any) {
	line := fmt.Sprintf("[%s] %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
	fmt.Fprint(os.Stderr, line)
	if dir := os.Getenv("APPDATA"); dir != "" {
		logPath := filepath.Join(dir, "MatricaRMZ", "watchdog.log")
		if f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			_, _ = f.WriteString(line)
			f.Close()
		}
	}
}
