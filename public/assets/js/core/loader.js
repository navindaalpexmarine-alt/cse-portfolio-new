/**
 * Lazy loader for heavy third-party libraries.
 * Chart.js (~200 KB) loads only when a chart is shown; SheetJS (~950 KB) only
 * when an Excel file is imported. Pinned versions + Subresource Integrity.
 */
import { cssVar } from './utils.js';

const LIBS = {
  chart: {
    src: 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
    integrity: 'sha384-bs/nf9FbdNouRbMiFcrcZfLXYPKiPaGVGplVbv7dLGECccEXDW+S3zjqSKR5ZEaD',
    global: 'Chart',
  },
  // Official SheetJS CDN (0.20.x includes security fixes not published to npm/cdnjs).
  xlsx: {
    src: 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
    integrity: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT',
    global: 'XLSX',
  },
};

const pending = {};

export function loadLib(name) {
  const lib = LIBS[name];
  if (window[lib.global]) return Promise.resolve(window[lib.global]);
  if (!pending[name]) {
    pending[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = lib.src;
      s.integrity = lib.integrity;
      s.crossOrigin = 'anonymous';
      s.async = true;
      s.onload = () => resolve(window[lib.global]);
      s.onerror = () => {
        delete pending[name];
        s.remove();
        reject(new Error(`Could not load ${name} library (offline?)`));
      };
      document.head.appendChild(s);
    });
  }
  return pending[name];
}

/** Loads Chart.js and applies theme-aware global defaults. */
export async function ensureChart() {
  const Chart = await loadLib('chart');
  applyChartTheme(Chart);
  return Chart;
}

export function applyChartTheme(Chart = window.Chart) {
  if (!Chart) return;
  Chart.defaults.color = cssVar('--muted');
  Chart.defaults.borderColor = cssVar('--grid');
  Chart.defaults.font.family = "'Inter', system-ui, sans-serif";
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.tooltip.backgroundColor = cssVar('--panel-2');
  Chart.defaults.plugins.tooltip.titleColor = cssVar('--ink');
  Chart.defaults.plugins.tooltip.bodyColor = cssVar('--ink');
  Chart.defaults.plugins.tooltip.borderColor = cssVar('--line');
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;
  Chart.defaults.animation.duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 400;
}

export const ensureXLSX = () => loadLib('xlsx');
