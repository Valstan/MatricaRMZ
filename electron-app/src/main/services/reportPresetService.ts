/**
 * Thin re-export shim: the report preset engine moved to ./reports/
 * (format / context / options / presets per domain / dispatch / render).
 * Importers keep this stable path.
 */
export * from './reports/index.js';
