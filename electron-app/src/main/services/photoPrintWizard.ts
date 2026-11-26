import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// МАСТЕР ПЕЧАТИ ФОТОГРАФИЙ для МНОГИХ файлов сразу (промт КАРМАНА #158).
//
// Что это: владелец просил «Microsoft Picture Manager, чтобы можно было скорректировать
// размер картинок и отправить уже на печать». Отдельной программы «Microsoft Picture
// Manager» в современной Windows нет — есть СИСТЕМНЫЙ МАСТЕР ПЕЧАТИ ФОТОГРАФИЙ
// (`photowiz.dll`, «Photo Printing with Templates Wizard»).
//
// Что проверено на машине (PC79, 26.11.2026, Windows 10.0.26300):
//
//  1. Глагола `print` у ПАПКИ нет. `Start-Process -FilePath <папка> -Verb print` →
//     «No application is associated with the specified file for this operation».
//     Значит «открыть мастер на папке» (как предлагалось в промте) невозможно.
//
//  2. Глагол `print` у КАРТИНКИ есть, и он как раз мастер печати фотографий:
//     `HKCR\SystemFileAssociations\image\shell\print\DropTarget` →
//     `photowiz.dll` (CLSID {60fd46de-f830-4894-a628-6fa81bc0190d}).
//
//  3. «По окну на файл» — отсюда и было «Picture Manager не срабатывает»: старый
//     `printImageViaOsWizard` вызывает глагол на КАЖДОМ файле отдельно.
//
//  4. ОДНО окно со всеми снимками даёт глагол у МНОЖЕСТВЕННОГО выделения — ровно то,
//     что делает Проводник (Ctrl+P по выделенным снимкам). Меню множественного
//     выделения берём у оболочки Windows: `IShellFolder::GetUIObjectOf` →
//     `IContextMenu`, и вызываем КАНОНИЧЕСКИЙ глагол `print`.
//
//  5. Сам мастер из чужого процесса («бросок» в photowiz напрямую) НЕ открывается:
//     `IDropTarget::Drop` отвечает E_INVALIDARG. То есть путь через оболочку —
//     единственный рабочий.
//
// Отдельный процесс PowerShell — по трём причинам:
//   * `photowiz.dll` грузится в адресное пространство вызывающего; в главном
//     процессе Electron это ломает всё приложение;
//   * окно мастера должно жить, пока оператор в нём работает;
//   * когда мастер закрывают, процесс завершается — по этому мы узнаём, что
//     оператор закончил, и возвращаем фокус в программу.
//
// Флагов `detached`/`windowsHide` быть НЕ должно: по грабле из `clientOpsService.ts`
// оба убивают графическое окно. Консоль PowerShell прячет сам `-WindowStyle Hidden`.

/** C#-часть помощника. Только ASCII: файл скрипта пишется без BOM, PowerShell 5.1 читает такие как ANSI. */
const HELPER_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("000214e6-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IShellFolderRaw
{
    [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, IntPtr pszDisplayName, IntPtr pcchEaten, IntPtr ppidl, IntPtr pdwAttributes);
    [PreserveSig] int EnumObjects(IntPtr hwnd, uint grfFlags, IntPtr ppenumIDList);
    [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
    [PreserveSig] int CreateViewObject(IntPtr hwndOwner, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [PreserveSig] int GetAttributesOf(uint cidl, IntPtr apidl, IntPtr rgfInOut);
    [PreserveSig] int GetUIObjectOf(IntPtr hwndOwner, uint cidl, IntPtr apidl, ref Guid riid, IntPtr rgfReserved, [MarshalAs(UnmanagedType.Interface)] out object ppv);
}

[ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IContextMenuRaw
{
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint indexMenu, uint idCmdFirst, uint idCmdLast, uint uFlags);
    [PreserveSig] int InsertMenuBefore(IntPtr hmenu, uint idCmdFirst, uint idBefore, [MarshalAs(UnmanagedType.LPWStr)] string lpString);
    [PreserveSig] int SetMenuDefaultItem(IntPtr hmenu, uint uIDItem, uint uFlags);
    [PreserveSig] int GetMenuString(IntPtr hmenu, uint uIDItem, [Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder lpStr, int cchMax, uint uFlag);
    [PreserveSig] int InvokeCommand(IntPtr pcmci, IntPtr pcmd);
}

[StructLayout(LayoutKind.Sequential)]
struct CMINVOKECOMMANDINFO
{
    public uint cbSize;
    public uint fMask;
    public IntPtr hwnd;
    public IntPtr lpVerb;
    public IntPtr lpParameters;
    public IntPtr lpDirectory;
    public int nShow;
    public uint dwHotKey;
    public IntPtr hIcon;
}

public static class MatricaPhotoWizard
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHParseDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr bc, out IntPtr pidl);

    [DllImport("shell32.dll", PreserveSig = false)]
    static extern void SHGetDesktopFolder([MarshalAs(UnmanagedType.Interface)] out IShellFolderRaw psf);

    [DllImport("shell32.dll", PreserveSig = true)]
    static extern IntPtr ILFindChild(IntPtr parent, IntPtr child);

    [DllImport("user32.dll")]
    static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll")]
    static extern bool DestroyMenu(IntPtr hMenu);

    [DllImport("ole32.dll")]
    static extern void CoTaskMemFree(IntPtr pv);

    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);

    public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);

    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr h);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

    /// Открыть мастер печати фотографий на ВСЕ снимки сразу.
    /// Возвращает "ok" либо текст причины (её показывает оператору).
    public static string Open(string[] files)
    {
        if (files == null || files.Length == 0) return "no-files";
        string folder = System.IO.Path.GetDirectoryName(files[0]);
        if (string.IsNullOrEmpty(folder)) return "no-folder";

        IntPtr folderPidl;
        SHParseDisplayName(folder, IntPtr.Zero, out folderPidl);

        IShellFolderRaw desktop;
        SHGetDesktopFolder(out desktop);
        Guid iidShellFolder = new Guid("000214e6-0000-0000-c000-000000000046");
        object psfObj;
        desktop.BindToObject(folderPidl, IntPtr.Zero, ref iidShellFolder, out psfObj);
        IShellFolderRaw psf = (IShellFolderRaw)psfObj;

        int n = files.Length;
        IntPtr[] children = new IntPtr[n];
        for (int i = 0; i < n; i++)
        {
            IntPtr abs;
            SHParseDisplayName(files[i], IntPtr.Zero, out abs);
            children[i] = ILFindChild(folderPidl, abs);
            CoTaskMemFree(abs);
        }
        IntPtr arr = Marshal.AllocHGlobal(IntPtr.Size * n);
        for (int i = 0; i < n; i++) Marshal.WriteIntPtr(arr, i * IntPtr.Size, children[i]);

        Guid iidCtxMenu = new Guid("000214e4-0000-0000-c000-000000000046");
        object ctxObj;
        psf.GetUIObjectOf(IntPtr.Zero, (uint)n, arr, ref iidCtxMenu, IntPtr.Zero, out ctxObj);
        IContextMenuRaw menu = (IContextMenuRaw)ctxObj;

        IntPtr hmenu = CreatePopupMenu();
        menu.QueryContextMenu(hmenu, 0, 0x4000, 0x4100, 0);

        CMINVOKECOMMANDINFO cmi = new CMINVOKECOMMANDINFO();
        cmi.cbSize = (uint)Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
        cmi.fMask = 0;
        cmi.nShow = 1;
        cmi.lpVerb = Marshal.StringToHGlobalAnsi("print");
        IntPtr pcmi = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO)));
        Marshal.StructureToPtr(cmi, pcmi, false);
        menu.InvokeCommand(pcmi, IntPtr.Zero);
        DestroyMenu(hmenu);
        return "ok";
    }

    /// Есть ли у этого процесса видимое окно (мастер печати).
    /// Консоль PowerShell скрыта, значит видимое окно — это мастер.
    public static bool HasVisibleWindow()
    {
        bool found = false;
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        EnumWindows((h, p) =>
        {
            if (!IsWindowVisible(h)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == self) found = true;
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
`;

/** Обёртка PowerShell: компилируем C#, открываем мастер, ждём его закрытия. */
const HELPER_PS = `$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$files = @(Get-Content -Raw -Encoding UTF8 (Join-Path $here 'files.json') | ConvertFrom-Json)
Add-Type -TypeDefinition @'
${HELPER_CSHARP}
'@
$res = [MatricaPhotoWizard]::Open([string[]]$files)
if ($res -ne 'ok') { Write-Output $res; exit 2 }
$deadline = (Get-Date).AddMinutes(60)
while ((Get-Date) -lt $deadline) {
  if (-not [MatricaPhotoWizard]::HasVisibleWindow()) { break }
  Start-Sleep -Milliseconds 500
}
Write-Output 'ok'
exit 0
`;

/**
 * Открыть мастер печати фотографий на всех отмеченных файлах.
 *
 * Ждёт, пока оператор закроет мастер: возврат обещания — это и есть сигнал
 * «окно закрылось», по которому программа возвращает фокус и убирает копии.
 */
export async function openPhotoPrintWizard(
  paths: string[],
  opts: { workDir: string; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Системный мастер печати фотографий — только на Windows' };
  }
  const scriptPath = join(opts.workDir, 'photo-wizard.ps1');
  const listPath = join(opts.workDir, 'files.json');
  try {
    await writeFile(listPath, JSON.stringify(list), 'utf8');
    await writeFile(scriptPath, HELPER_PS, 'utf8');
  } catch (e) {
    return { ok: false, error: `Не удалось подготовить мастер печати: ${String(e)}` };
  }

  const timeoutMs = opts.timeoutMs ?? 65 * 60 * 1000;
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    let err = '';
    const finish = (result: { ok: true } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        // НЕ detached и НЕ windowsHide: по грабле из clientOpsService.ts оба флага
        // убивают графическое окно (мастер печати).
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false },
      );
    } catch (e) {
      finish({ ok: false, error: `Не удалось запустить мастер печати: ${String(e)}` });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', (e) => finish({ ok: false, error: `Не удалось запустить мастер печати: ${String(e)}` }));
    child.on('exit', (code) => {
      if (code === 0) {
        finish({ ok: true });
        return;
      }
      const reason = (err || out).trim().split('\n').filter(Boolean).slice(-3).join(' ');
      finish({ ok: false, error: reason ? `Мастер печати не открылся: ${reason}` : 'Мастер печати не открылся' });
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Процесс уже мёртв — ничего делать не надо.
      }
      finish({ ok: false, error: 'Мастер печати не закрыли за час — действие отменено' });
    }, timeoutMs);
    timer.unref?.();
  });
}
