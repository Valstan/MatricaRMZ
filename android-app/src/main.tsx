// Order matters: polyfills first, then the bridge shim must exist before the
// renderer bundle evaluates (main.tsx hard-gates on window.matrica presence).
import './boot/polyfills';
import './bridge/shim';
import '../../electron-app/src/renderer/src/main.tsx';
