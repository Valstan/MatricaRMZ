package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// --- окно статуса -----------------------------------------------------------
//
// Единственное, что пользователь вообще видит от matricarmz-watchdog.exe.
//
// Зачем: тихая переустановка тянется до 15 минут, и всё это время на экране не
// происходит ничего — оператор решает, что машина зависла, и выключает её прямо
// посреди установки. Окно поднимается ТОЛЬКО когда начато реальное действие:
// здоровый плановый проход раз в 15 минут обязан оставаться невидимым, иначе окно
// замигает на всём парке каждые четверть часа.
//
// Голый Win32 через syscall, потому что в go.mod сторожа нет ни одной зависимости
// и не будет: CI собирает его без сети и без vendoring, а одиночный маленький exe
// без внешних библиотек — часть того, чем сторож не похож на загрузчик вредоноса
// (ADR-0002). Библиотеки берём только из списка KnownDLLs (user32, gdi32,
// kernel32): их Windows резолвит из System32 мимо каталога программы, поэтому
// подменить их рядом с exe нельзя.

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procRegisterClassExW = user32.NewProc("RegisterClassExW")
	procCreateWindowExW  = user32.NewProc("CreateWindowExW")
	procDestroyWindow    = user32.NewProc("DestroyWindow")
	procDefWindowProcW   = user32.NewProc("DefWindowProcW")
	procShowWindow       = user32.NewProc("ShowWindow")
	procUpdateWindow     = user32.NewProc("UpdateWindow")
	procSetForegroundWnd = user32.NewProc("SetForegroundWindow")
	procSetWindowTextW   = user32.NewProc("SetWindowTextW")
	procInvalidateRect   = user32.NewProc("InvalidateRect")
	procGetClientRect    = user32.NewProc("GetClientRect")
	procGetMessageW      = user32.NewProc("GetMessageW")
	procTranslateMessage = user32.NewProc("TranslateMessage")
	procDispatchMessageW = user32.NewProc("DispatchMessageW")
	procPostMessageW     = user32.NewProc("PostMessageW")
	procPostQuitMessage  = user32.NewProc("PostQuitMessage")
	procSendMessageW     = user32.NewProc("SendMessageW")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procLoadCursorW      = user32.NewProc("LoadCursorW")

	procCreateFontW    = gdi32.NewProc("CreateFontW")
	procGetStockObject = gdi32.NewProc("GetStockObject")
	procSetBkMode      = gdi32.NewProc("SetBkMode")

	procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmDestroy        = 0x0002
	wmSetFont        = 0x0030
	wmCtlColorStatic = 0x0138
	// Приватные сообщения окна: диапазон WM_APP+N отдан приложению и извне не приходит.
	wmAppSetText = 0x8000 + 1
	wmAppClose   = 0x8000 + 2

	wsOverlapped = 0x00000000
	wsCaption    = 0x00C00000
	wsSysMenu    = 0x00080000
	wsChild      = 0x40000000
	wsVisible    = 0x10000000
	ssCenter     = 0x00000001

	swShowNormal   = 1
	smCXScreen     = 0
	smCYScreen     = 1
	colorWindow    = 5
	idcArrow       = 32512
	whiteBrush     = 0
	defaultGUIFont = 17
	bkTransparent  = 1
	fwNormal       = 400
	defaultCharset = 1
	cleartypeQual  = 5

	statusWinW = 460
	statusWinH = 150
	// Итоговую строку надо успеть прочитать: окно гаснет вместе с процессом.
	statusFinalPause = 4 * time.Second
	// Окно не вправе задерживать восстановление: не поднялось за это время —
	// идём дальше без него.
	statusWaitTimeout = 2 * time.Second
)

type wndClassExW struct {
	CbSize        uint32
	Style         uint32
	LpfnWndProc   uintptr
	CbClsExtra    int32
	CbWndExtra    int32
	HInstance     uintptr
	HIcon         uintptr
	HCursor       uintptr
	HbrBackground uintptr
	LpszMenuName  *uint16
	LpszClassName *uint16
	HIconSm       uintptr
}

type msgW struct {
	Hwnd     uintptr
	Message  uint32
	WParam   uintptr
	LParam   uintptr
	Time     uint32
	PtX      int32
	PtY      int32
	LPrivate uint32
}

type rectW struct{ Left, Top, Right, Bottom int32 }

// Всё, чей адрес уходит в Windows API, живёт в пакетных переменных, а не на стеке
// горутины: стек Go при росте переезжает в другое место, и уже отданный наружу
// адрес локальной переменной протухает. Окно в стороже заведомо одно, поэтому цена
// такого правила — три переменные, а не механизм. Нарушать его нельзя: поломка
// была бы редкой и молчаливой.
var (
	statusClass wndClassExW
	statusMsg   msgW
	statusRect  rectW

	statusClassNamePtr   *uint16
	statusTitlePtr       *uint16
	statusStaticClassPtr *uint16
	statusFontFacePtr    *uint16

	statusClassOnce sync.Once
	statusClassErr  error
	statusFontOnce  sync.Once
	statusFontH     uintptr
)

var statusWin struct {
	mu   sync.Mutex
	open bool
	// dismissed: окно закрыл человек. Больше не поднимаем — иначе табличка, которую
	// только что прогнали, всплывает на следующем этапе и лезет на передний план.
	dismissed bool
	hwnd      uintptr
	label     uintptr
	text      string
	textPtr   *uint16
	done      chan struct{}
}

// ptrOf — единственный мост «адрес Go-значения → uintptr» в оконном коде:
// syscall.LazyProc.Call принимает только uintptr, а Windows API ждёт адресов строк
// и структур. Сведено в одну строку намеренно — грабля M57: semgrep блокирует PR за
// каждое упоминание unsafe, а исключение ставится построчно. Арифметики над
// указателями здесь нет и обратного преобразования uintptr→Pointer тоже; за то, что
// объект переживёт вызов, отвечает правило над блоком переменных выше.
// nosemgrep: use-of-unsafe-block
func ptrOf[T any](v *T) uintptr { return uintptr(unsafe.Pointer(v)) }

func utf16Ptr(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		return nil
	}
	return p
}

// statusShow поднимает окно (а если оно уже есть — просто меняет строку) и ждёт,
// пока оно появится на экране: сразу за вызовом начинается длинная работа, ради
// которой окно и показано.
func statusShow(text string) {
	defer func() { _ = recover() }()

	statusWin.mu.Lock()
	statusWin.text = text
	if statusWin.dismissed {
		statusWin.mu.Unlock()
		return
	}
	if statusWin.open {
		hwnd := statusWin.hwnd
		statusWin.mu.Unlock()
		if hwnd != 0 {
			procPostMessageW.Call(hwnd, wmAppSetText, 0, 0)
		}
		return
	}
	statusWin.open = true
	statusWin.done = make(chan struct{})
	done := statusWin.done
	statusWin.mu.Unlock()

	ready := make(chan struct{})
	go statusWindowLoop(ready, done)
	select {
	case <-ready:
	case <-time.After(statusWaitTimeout):
	}
}

// statusSet меняет строку этапа. Безопасно звать из главной горутины и когда окна
// нет вовсе (плановый проход) — тогда это пустышка.
func statusSet(text string) {
	defer func() { _ = recover() }()
	statusWin.mu.Lock()
	statusWin.text = text
	hwnd := statusWin.hwnd
	statusWin.mu.Unlock()
	if hwnd == 0 {
		return
	}
	// Только PostMessageW: рисует окно исключительно поток-владелец, а прямой вызов
	// из чужой горутины ушёл бы в блокирующий SendMessage внутри USER32.
	procPostMessageW.Call(hwnd, wmAppSetText, 0, 0)
}

// statusFinal показывает итог и даёт его прочитать, прежде чем окно уйдёт вместе с
// процессом. Без окна — мгновенная пустышка: плановый проход не должен простаивать
// четыре секунды впустую.
func statusFinal(text string) {
	statusWin.mu.Lock()
	open := statusWin.open
	statusWin.mu.Unlock()
	if !open {
		return
	}
	statusSet(text)
	time.Sleep(statusFinalPause)
	statusClose()
}

// statusClose закрывает окно и дожидается, пока поток-владелец отработает: сразу за
// этим процесс завершается, и недорисованное окно осталось бы висеть призраком.
func statusClose() {
	defer func() { _ = recover() }()
	statusWin.mu.Lock()
	open := statusWin.open
	hwnd := statusWin.hwnd
	done := statusWin.done
	statusWin.open = false
	statusWin.mu.Unlock()
	if !open {
		return
	}
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, wmAppClose, 0, 0)
	}
	if done == nil {
		return
	}
	select {
	case <-done:
	case <-time.After(statusWaitTimeout):
	}
}

func statusWindowLoop(ready, done chan struct{}) {
	// Окно принадлежит потоку, который его создал: сообщения приходят только туда.
	// Без LockOSThread планировщик Go унесёт горутину на другой поток, и цикл
	// перестанет получать сообщения своего же окна.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(done)
	defer func() {
		statusWin.mu.Lock()
		// Цикл кончился сам, хотя программно окно никто не закрывал (statusClose
		// снимает open ДО сообщения) — значит, крестик нажал человек.
		if statusWin.open && statusWin.hwnd != 0 {
			statusWin.dismissed = true
		}
		statusWin.open, statusWin.hwnd, statusWin.label = false, 0, 0
		statusWin.mu.Unlock()
	}()
	var once sync.Once
	signalReady := func() { once.Do(func() { close(ready) }) }
	defer signalReady()
	defer func() {
		if r := recover(); r != nil {
			logf("окно статуса упало (%v) — проход продолжается без него", r)
		}
	}()

	if err := statusCreateWindow(); err != nil {
		logf("окно статуса не создано (%v) — проход идёт без него", err)
		return
	}

	statusWin.mu.Lock()
	text, wanted, hwnd := statusWin.text, statusWin.open, statusWin.hwnd
	statusWin.mu.Unlock()
	statusApplyText(text)
	signalReady()
	if !wanted {
		// statusClose успел отработать, пока окно создавалось.
		procDestroyWindow.Call(hwnd)
	}

	for {
		r, _, _ := procGetMessageW.Call(ptrOf(&statusMsg), 0, 0, 0)
		if int32(r) <= 0 { // 0 — пришёл WM_QUIT, -1 — ошибка
			return
		}
		procTranslateMessage.Call(ptrOf(&statusMsg))
		procDispatchMessageW.Call(ptrOf(&statusMsg))
	}
}

func statusCreateWindow() error {
	if err := statusRegisterClass(); err != nil {
		return err
	}
	cx, _, _ := procGetSystemMetrics.Call(smCXScreen)
	cy, _, _ := procGetSystemMetrics.Call(smCYScreen)
	x, y := (int32(cx)-statusWinW)/2, (int32(cy)-statusWinH)/2
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	// Без «свернуть»/«развернуть»: это не приложение, а табличка на время работы.
	hwnd, _, err := procCreateWindowExW.Call(
		0,
		ptrOf(statusClassNamePtr),
		ptrOf(statusTitlePtr),
		wsOverlapped|wsCaption|wsSysMenu,
		uintptr(x), uintptr(y), statusWinW, statusWinH,
		0, 0, statusInstance(), 0,
	)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW: %v", err)
	}
	lx, ly, lw, lh := statusLabelRect(hwnd)
	// SS_CENTER сам переносит длинную строку на вторую строчку — отдельная разметка
	// под «Переустанавливаю Матрицу. До 15 минут…» не нужна.
	label, _, lerr := procCreateWindowExW.Call(
		0,
		ptrOf(statusStaticClassPtr),
		0,
		wsChild|wsVisible|ssCenter,
		uintptr(lx), uintptr(ly), uintptr(lw), uintptr(lh),
		hwnd, 0, statusInstance(), 0,
	)
	if label == 0 {
		procDestroyWindow.Call(hwnd)
		return fmt.Errorf("CreateWindowExW(STATIC): %v", lerr)
	}
	if f := statusFont(); f != 0 {
		procSendMessageW.Call(label, wmSetFont, f, 1)
	}
	statusWin.mu.Lock()
	statusWin.hwnd, statusWin.label = hwnd, label
	statusWin.mu.Unlock()
	procShowWindow.Call(hwnd, swShowNormal)
	procUpdateWindow.Call(hwnd)
	// Сторож стартует из планировщика, и окно рискует открыться за чужими — просим
	// передний план. Windows вправе отказать: тогда мигнёт кнопка в панели задач.
	procSetForegroundWnd.Call(hwnd)
	return nil
}

// statusLabelRect кладёт подпись по центру клиентской области. Её размер спрашиваем
// у самой Windows, а не вычитаем «примерно заголовок»: высота заголовка зависит от
// темы и версии системы.
func statusLabelRect(hwnd uintptr) (x, y, w, h int32) {
	const margin, box = 14, 52
	procGetClientRect.Call(hwnd, ptrOf(&statusRect))
	cw, ch := statusRect.Right-statusRect.Left, statusRect.Bottom-statusRect.Top
	if cw <= 2*margin || ch <= 0 {
		cw, ch = statusWinW, statusWinH
	}
	h = box
	if h > ch {
		h = ch
	}
	return margin, (ch - h) / 2, cw - 2*margin, h
}

func statusRegisterClass() error {
	statusClassOnce.Do(func() {
		statusClassNamePtr = utf16Ptr("MatricaRMZWatchdogStatus")
		statusTitlePtr = utf16Ptr("Матрица РМЗ")
		statusStaticClassPtr = utf16Ptr("STATIC")
		statusFontFacePtr = utf16Ptr("Segoe UI")

		// Windows требует, чтобы структура сама несла свой размер. Это compile-time
		// Sizeof, без арифметики над указателями — ровно как в processRunning.
		// nosemgrep: use-of-unsafe-block
		statusClass.CbSize = uint32(unsafe.Sizeof(statusClass))
		statusClass.LpfnWndProc = syscall.NewCallback(statusWndProc)
		statusClass.HInstance = statusInstance()
		statusClass.HbrBackground = colorWindow + 1
		cursor, _, _ := procLoadCursorW.Call(0, idcArrow)
		statusClass.HCursor = cursor
		statusClass.LpszClassName = statusClassNamePtr
		if ret, _, err := procRegisterClassExW.Call(ptrOf(&statusClass)); ret == 0 {
			statusClassErr = fmt.Errorf("RegisterClassExW: %v", err)
		}
	})
	return statusClassErr
}

func statusInstance() uintptr {
	h, _, _ := procGetModuleHandleW.Call(0)
	return h
}

// statusFont — системный Segoe UI 9 pt. Без явного шрифта Windows рисует контрол
// системным Fixedsys, и окно выглядит как аварийное сообщение из девяностых.
// Высота −12 — это 9 pt при 96 DPI; манифеста DPI-awareness у сторожа нет, поэтому
// другого DPI он и не видит: масштабирует окно сама система.
func statusFont() uintptr {
	statusFontOnce.Do(func() {
		height := int32(-12)
		h, _, _ := procCreateFontW.Call(
			uintptr(height), 0, 0, 0, fwNormal, 0, 0, 0,
			defaultCharset, 0, 0, cleartypeQual, 0,
			ptrOf(statusFontFacePtr),
		)
		if h == 0 {
			h, _, _ = procGetStockObject.Call(defaultGUIFont)
		}
		statusFontH = h
	})
	return statusFontH
}

// statusApplyText зовётся только из потока-владельца окна.
func statusApplyText(text string) {
	statusWin.mu.Lock()
	label := statusWin.label
	p := utf16Ptr(text)
	// Указатель держим в пакетной структуре: строку читает Windows, а сборщик Go
	// должен видеть, что она ещё нужна.
	statusWin.textPtr = p
	statusWin.mu.Unlock()
	if label == 0 || p == nil {
		return
	}
	procSetWindowTextW.Call(label, ptrOf(p))
	procInvalidateRect.Call(label, 0, 1)
}

func statusWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	defer func() { _ = recover() }()
	switch msg {
	case wmAppSetText:
		statusWin.mu.Lock()
		text := statusWin.text
		statusWin.mu.Unlock()
		statusApplyText(text)
		return 0
	case wmAppClose:
		// Закрытие приходит из главной горутины сообщением, а не прямым вызовом:
		// DestroyWindow законен только в потоке, создавшем окно.
		procDestroyWindow.Call(hwnd)
		return 0
	case wmCtlColorStatic:
		// Подпись должна лежать на том же белом фоне, что и окно: по умолчанию STATIC
		// закрашивает себя серым цветом диалогов и выглядит заплаткой.
		procSetBkMode.Call(wparam, bkTransparent)
		brush, _, _ := procGetStockObject.Call(whiteBrush)
		return brush
	case wmDestroy:
		// PostQuitMessage — единственный законный способ остановить цикл сообщений,
		// и звать его можно только из потока-владельца.
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(hwnd, msg, wparam, lparam)
	return ret
}
