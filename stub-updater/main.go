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
// пройдёт тот же путь.
//
// UI — консольное окно (сборка БЕЗ -H=windowsgui): старый updater запускает
// инсталлятор через shell.openPath, у GUI-заглушки при этом не видно вообще
// ничего, и оператор минутами не понимает, идёт обновление или всё умерло
// (реальная жалоба владельца 2026-08-17). Консоль показывает каждый шаг и
// процент скачивания; при ошибке окно держится, чтобы текст успели прочитать.
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
	"syscall"
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

// Консоль Windows по умолчанию в CP866 — русский UTF-8 в ней превращается в
// кракозябры. Переключаем кодовую страницу вывода на UTF-8 (65001); вызов без
// unsafe (аргумент — голый uintptr), при любой ошибке просто молчим.
func setConsoleUTF8() {
	defer func() { _ = recover() }()
	proc := syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleOutputCP")
	_, _, _ = proc.Call(uintptr(65001))
}

// logf пишет и в лог-файл, и на экран: файл — для разбора «что было на той
// машине», консоль — чтобы оператор видел, что обновление живо.
func logf(f *os.File, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	if f != nil {
		_, _ = f.WriteString(fmt.Sprintf("%s %s\n", time.Now().Format("2006-01-02 15:04:05"), msg))
	}
	fmt.Println(msg)
}

// sayf — только на экран (человекочитаемые строки, дублировать их в лог незачем).
func sayf(format string, args ...any) {
	fmt.Printf(format+"\n", args...)
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

// progressWriter печатает процент скачивания каждые ~10%, чтобы в консоли было
// видно движение даже на медленной заводской сети.
type progressWriter struct {
	total    int64
	done     int64
	lastMark int64
}

func (p *progressWriter) Write(b []byte) (int, error) {
	p.done += int64(len(b))
	if p.total > 0 {
		pct := p.done * 100 / p.total
		if pct >= p.lastMark+10 || pct == 100 {
			p.lastMark = pct - pct%10
			sayf("  скачано %d%% (%d из %d МБ)", pct, p.done/(1024*1024), p.total/(1024*1024))
		}
	}
	return len(b), nil
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
	n, err := io.Copy(io.MultiWriter(f, h, &progressWriter{total: plan.Latest.Size}), resp.Body)
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

// failPause держит консоль открытой при ошибке: оператор должен успеть
// прочитать, что случилось, иначе окно схлопывается и «опять ничего не видно».
func failPause(logFile *os.File, format string, args ...any) {
	logf(logFile, format, args...)
	sayf("")
	sayf("ОБНОВЛЕНИЕ НЕ УДАЛОСЬ. Запустите программу ещё раз — попытка повторится.")
	sayf("Окно закроется через 2 минуты.")
	time.Sleep(2 * time.Minute)
	os.Exit(1)
}

func main() {
	setConsoleUTF8()
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
	sayf("=== Обновление МатрицаРМЗ ===")
	sayf("Переход на новое поколение программы. НЕ закрывайте это окно.")
	sayf("")
	logf(logFile, "stub-updater start, server=%s", server)

	client := &http.Client{Timeout: 15 * time.Minute}
	planClient := &http.Client{Timeout: 30 * time.Second}

	// Несколько попыток с паузой: заглушку часто запускают сразу после скачивания,
	// сеть может ещё моргать. Больше трёх не имеет смысла — старый updater перезапустит
	// весь цикл при следующей проверке обновлений.
	sayf("Шаг 1/3: запрашиваю у сервера, какая версия свежая…")
	var plan *planResponse
	var err error
	for attempt := 1; attempt <= 3; attempt++ {
		plan, err = fetchPlan(planClient, server)
		if err == nil {
			break
		}
		logf(logFile, "plan attempt %d failed: %v", attempt, err)
		sayf("  не вышло (попытка %d из 3), жду и пробую ещё…", attempt)
		time.Sleep(time.Duration(attempt) * 5 * time.Second)
	}
	if err != nil {
		failPause(logFile, "giving up: no plan (%v)", err)
	}
	logf(logFile, "plan: action=%s target=%s (%d bytes)", plan.Action, plan.Latest.Version, plan.Latest.Size)
	sayf("")
	sayf("Шаг 2/3: скачиваю новую версию %s (%d МБ)…", plan.Latest.Version, plan.Latest.Size/(1024*1024))

	dest, err := downloadInstaller(client, plan, os.TempDir())
	if err != nil {
		failPause(logFile, "download failed: %v", err)
	}
	logf(logFile, "downloaded: %s", dest)

	sayf("")
	sayf("Шаг 3/3: запускаю установку. Старая версия будет удалена, новая установится сама.")
	// Запускаем настоящий инсталлятор отвязанно и выходим — NSIS доделает остальное.
	cmd := exec.Command(dest)
	if err := cmd.Start(); err != nil {
		failPause(logFile, "installer start failed: %v", err)
	}
	_ = cmd.Process.Release()
	logf(logFile, "installer launched, stub exits")
	sayf("")
	sayf("Готово: установка запущена. Это окно закроется через 10 секунд,")
	sayf("дальше работает установщик — после него программа запустится обновлённой.")
	time.Sleep(10 * time.Second)
}
