// Заглушка-обновлятор («мост в один прыжок»).
//
// Клиенты, выпущенные до перехода на нумерацию поколений (3.1.0), сравнивают версии
// по числам: 3 < 2026, поэтому настоящий новый релиз они считают откатом и никогда
// его не поставят. Дотянуться до их кода нельзя — зато можно скормить им «новую
// версию»: сервер навсегда отдаёт старому каналу ЭТОТ файл под CalVer-огромным
// номером (2026.1231.2359). Старый клиент скачивает и запускает его как обычный
// инсталлятор — а он вместо установки:
//
//  1. спрашивает Диспетчер (GET /dispatcher/update-plan?current=stub),
//  2. скачивает настоящий свежий дистрибутив (проверяя размер и sha256),
//  3. запускает его установку и выходит — дальше NSIS сам чистит старое и ставит
//     новое, а установленная 3.x уже умеет обновляться через Диспетчер сама.
//
// Файл остаётся на сервере навсегда: очень древний клиент, оживший через год,
// пройдёт тот же путь. Никакого UI: старый updater запускает инсталляторы молча,
// прогресс он уже показал при скачивании заглушки.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const defaultServer = "https://a6fd55b8e0ae.vps.myjino.ru"

type planLatest struct {
	Version  string `json:"version"`
	FileName string `json:"fileName"`
	Size     int64  `json:"size"`
	Sha256   string `json:"sha256"`
	URL      string `json:"url"`
}

type planResponse struct {
	Ok     bool       `json:"ok"`
	Action string     `json:"action"`
	Latest planLatest `json:"latest"`
	Error  string     `json:"error"`
}

func logf(f *os.File, format string, args ...any) {
	line := fmt.Sprintf("%s %s\n", time.Now().Format("2006-01-02 15:04:05"), fmt.Sprintf(format, args...))
	if f != nil {
		_, _ = f.WriteString(line)
	}
}

func openLog() *os.File {
	dir := os.Getenv("APPDATA")
	if dir == "" {
		dir = os.TempDir()
	}
	path := filepath.Join(dir, "MatricaRMZ", "stub-updater.log")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil
	}
	return f
}

func fetchPlan(client *http.Client, server string) (*planResponse, error) {
	url := strings.TrimRight(server, "/") + "/dispatcher/update-plan?current=stub"
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dispatcher HTTP %d", resp.StatusCode)
	}
	var plan planResponse
	if err := json.NewDecoder(resp.Body).Decode(&plan); err != nil {
		return nil, err
	}
	if !plan.Ok {
		return nil, fmt.Errorf("dispatcher error: %s", plan.Error)
	}
	if plan.Action != "update" && plan.Action != "up-to-date" {
		return nil, fmt.Errorf("dispatcher action=%s", plan.Action)
	}
	if plan.Latest.URL == "" || plan.Latest.FileName == "" || plan.Latest.Size <= 0 {
		return nil, fmt.Errorf("dispatcher plan incomplete")
	}
	return &plan, nil
}

func downloadInstaller(client *http.Client, plan *planResponse, destDir string) (string, error) {
	dest := filepath.Join(destDir, plan.Latest.FileName)
	resp, err := client.Get(plan.Latest.URL)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download HTTP %d", resp.StatusCode)
	}
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), resp.Body)
	closeErr := f.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if n != plan.Latest.Size {
		return "", fmt.Errorf("size mismatch: got=%d want=%d", n, plan.Latest.Size)
	}
	if plan.Latest.Sha256 != "" && !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), plan.Latest.Sha256) {
		return "", fmt.Errorf("sha256 mismatch")
	}
	return dest, nil
}

func main() {
	logFile := openLog()
	defer func() {
		if logFile != nil {
			_ = logFile.Close()
		}
	}()

	server := os.Getenv("MATRICA_API_URL")
	if server == "" {
		server = defaultServer
	}
	logf(logFile, "stub-updater start, server=%s", server)

	client := &http.Client{Timeout: 15 * time.Minute}
	planClient := &http.Client{Timeout: 30 * time.Second}

	// Несколько попыток с паузой: заглушку часто запускают сразу после скачивания,
	// сеть может ещё моргать. Больше трёх не имеет смысла — старый updater перезапустит
	// весь цикл при следующей проверке обновлений.
	var plan *planResponse
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		plan, err = fetchPlan(planClient, server)
		if err == nil {
			break
		}
		logf(logFile, "plan attempt %d failed: %v", attempt, err)
		time.Sleep(time.Duration(attempt) * 5 * time.Second)
	}
	if err != nil {
		logf(logFile, "giving up: no plan")
		os.Exit(1)
	}
	logf(logFile, "plan: action=%s target=%s (%d bytes)", plan.Action, plan.Latest.Version, plan.Latest.Size)

	dest, err := downloadInstaller(client, plan, os.TempDir())
	if err != nil {
		logf(logFile, "download failed: %v", err)
		os.Exit(1)
	}
	logf(logFile, "downloaded: %s", dest)

	// Запускаем настоящий инсталлятор отвязанно и выходим — NSIS доделает остальное.
	cmd := exec.Command(dest)
	if err := cmd.Start(); err != nil {
		logf(logFile, "installer start failed: %v", err)
		os.Exit(1)
	}
	_ = cmd.Process.Release()
	logf(logFile, "installer launched, stub exits")
}
