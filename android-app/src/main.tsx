// Order matters: the bridge shim must exist before the renderer bundle
// evaluates (main.tsx hard-gates on window.matrica presence).
import './bridge/shim';
import '../../electron-app/src/renderer/src/main.tsx';
