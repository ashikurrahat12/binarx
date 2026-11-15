import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  CandlestickChart,
  TrendingUp,
  BarChart2,
  Activity,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Crosshair,
  Minus,
  SeparatorVertical,
  ArrowUpRight,
  Square,
  GitCommitHorizontal,
  Trash2,
  Undo2,
  SlidersHorizontal,
  X,
  Plus,
  Pencil,
  Info,
} from 'lucide-react';
import type {
  AssetDefinition,
  Candle,
  ChartDrawing,
  ChartType,
  DrawingPoint,
  DrawingTool,
  IndicatorConfig,
  IndicatorId,
  MarketQuote,
  PendingOrder,
  TerminalSettings,
  Timeframe,
  Trade,
  TradeDirection,
} from '../types/trading.ts';
import { TIMEFRAME_SECONDS } from '../constants/assets.ts';
import {
  computeBollingerBands,
  computeEMA,
  computeMACD,
  computeRSI,
  computeSMA,
  computeStochastic,
  toHeikinAshi,
} from '../utils/indicators.ts';

interface TradingChartProps {
  asset: AssetDefinition;
  quote?: MarketQuote;
  candles: Candle[];
  loading: boolean;
  timeframe: Timeframe;
  onTimeframeChange: (tf: Timeframe) => void;
  chartType: ChartType;
  onChartTypeChange: (ct: ChartType) => void;
  indicators: IndicatorConfig[];
  onAddIndicator: (id: IndicatorId) => void;
  onRemoveIndicator: (uid: string) => void;
  onToggleIndicator: (uid: string) => void;
  activeTrades: Trade[];
  pendingOrders: PendingOrder[];
  hoverDirection: TradeDirection | null;
  selectedDurationSec: number;
  settings: TerminalSettings;
  drawings: ChartDrawing[];
  onAddDrawing: (drawing: ChartDrawing) => void;
  onUndoDrawing: () => void;
  onClearDrawings: () => void;
}

const TIMEFRAMES: Timeframe[] = ['5s', '10s', '15s', '30s', '1m', '5m', '15m', '1h'];

const INDICATOR_CATALOG: Array<{ id: IndicatorId; label: string; desc: string; defaultColor: string }> = [
  { id: 'sma', label: 'SMA (20)', desc: 'Simple Moving Average', defaultColor: '#F59E0B' },
  { id: 'ema', label: 'EMA (9)', desc: 'Exponential Moving Average', defaultColor: '#38BDF8' },
  { id: 'bollinger', label: 'Bollinger Bands (20, 2)', desc: 'Volatility envelope', defaultColor: '#A78BFA' },
  { id: 'rsi', label: 'RSI (14)', desc: 'Relative Strength Index', defaultColor: '#F472B6' },
  { id: 'macd', label: 'MACD (12, 26, 9)', desc: 'Trend momentum oscillator', defaultColor: '#2962FF' },
  { id: 'stochastic', label: 'Stochastic (14, 3)', desc: '%K / %D oscillator', defaultColor: '#10B981' },
];

const DRAWING_TOOLS: Array<{ id: DrawingTool; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'crosshair', label: 'Crosshair', icon: Crosshair },
  { id: 'trendline', label: 'Trend Line', icon: TrendingUp },
  { id: 'horizontal', label: 'Horizontal Line', icon: Minus },
  { id: 'vertical', label: 'Vertical Line', icon: SeparatorVertical },
  { id: 'ray', label: 'Ray', icon: ArrowUpRight },
  { id: 'rectangle', label: 'Rectangle', icon: Square },
  { id: 'fibonacci', label: 'Fibonacci', icon: GitCommitHorizontal },
];

export const TradingChart: React.FC<TradingChartProps> = ({
  asset,
  quote,
  candles,
  loading,
  timeframe,
  onTimeframeChange,
  chartType,
  onChartTypeChange,
  indicators,
  onAddIndicator,
  onRemoveIndicator,
  onToggleIndicator,
  activeTrades,
  pendingOrders,
  hoverDirection,
  selectedDurationSec,
  settings,
  drawings,
  onAddDrawing,
  onUndoDrawing,
  onClearDrawings,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [showIndicatorsMenu, setShowIndicatorsMenu] = useState(false);
  const [showChartTypeMenu, setShowChartTypeMenu] = useState(false);
  const [showTimeframeMenu, setShowTimeframeMenu] = useState(false);
  const [showDrawingMenu, setShowDrawingMenu] = useState(false);
  const [showPairInfo, setShowPairInfo] = useState(false);
  const [activeTool, setActiveTool] = useState<DrawingTool>('crosshair');
  const [clockText, setClockText] = useState(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  });

  useEffect(() => {
    const id = setInterval(() => {
      const d = new Date();
      setClockText(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Viewport state in refs for smooth 60fps pan/zoom without React re-render overhead
  const viewStateRef = useRef({
    candleWidth: 10,
    rightOffsetSlots: 14, // empty future slots on right for expiry line
    panOffsetCandles: 0,
    isDragging: false,
    dragStartX: 0,
    dragStartPan: 0,
    mouseX: -1,
    mouseY: -1,
    draftPoint: null as DrawingPoint | null,
  });

  // Reset pan when switching symbol or timeframe
  useEffect(() => {
    viewStateRef.current.panOffsetCandles = 0;
    viewStateRef.current.draftPoint = null;
  }, [asset.symbol, timeframe]);

  // Format timestamp for X-axis / crosshair
  const formatTimeLabel = useCallback((unixSec: number, includeDate = false) => {
    const d = new Date((unixSec + settings.timezoneOffsetMinutes * 60) * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    const ss = String(d.getUTCSeconds()).padStart(2, '0');
    if (includeDate) {
      const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
      const da = String(d.getUTCDate()).padStart(2, '0');
      return `${mo}/${da} ${hh}:${mm}:${ss}`;
    }
    return TIMEFRAME_SECONDS[timeframe] < 60 ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
  }, [settings.timezoneOffsetMinutes, timeframe]);

  // Helper to map canvas coordinates <-> (time, price)
  const getLayoutMetrics = useCallback((width: number, height: number) => {
    const rightAxisW = 76;
    const bottomAxisH = 26;
    const activeOscillators = indicators.filter(
      (ind) => ind.enabled && (ind.id === 'rsi' || ind.id === 'macd' || ind.id === 'stochastic')
    );
    const oscCount = Math.min(2, activeOscillators.length);
    const oscHeight = oscCount > 0 ? oscCount * 86 : 0;
    const plotW = Math.max(200, width - rightAxisW);
    const plotH = Math.max(160, height - bottomAxisH - oscHeight);
    return { rightAxisW, bottomAxisH, oscHeight, plotW, plotH, activeOscillators: activeOscillators.slice(0, 2) };
  }, [indicators]);

  // Main 60fps canvas animation loop
  useEffect(() => {
    let rafId = 0;

    const render = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) {
        rafId = requestAnimationFrame(render);
        return;
      }

      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.floor(rect.width * dpr);
      const targetH = Math.floor(rect.height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafId = requestAnimationFrame(render);
        return;
      }

      ctx.save();
      ctx.scale(dpr, dpr);

      const width = rect.width;
      const height = rect.height;
      const isChartDark = settings.templateMode === 'light_mode';

      // Background
      ctx.fillStyle = isChartDark ? '#131722' : '#FFFFFF';
      ctx.fillRect(0, 0, width, height);

      const { rightAxisW, bottomAxisH, plotW, plotH, activeOscillators } = getLayoutMetrics(width, height);
      const tfSec = TIMEFRAME_SECONDS[timeframe] || 60;
      const rawDisplayCandles = chartType === 'heikin_ashi' ? toHeikinAshi(candles) : candles;
      // Lock the live candle close/high/low strictly to the canonical live quote price
      const displayCandles = rawDisplayCandles.map((c, idx) => {
        if (idx === rawDisplayCandles.length - 1 && quote && quote.price > 0 && chartType !== 'heikin_ashi') {
          return {
            ...c,
            close: quote.price,
            high: Math.max(c.high, quote.price),
            low: Math.min(c.low, quote.price),
          };
        }
        return c;
      });

      const vs = viewStateRef.current;
      const slotW = vs.candleWidth;
      const visibleSlots = Math.floor(plotW / slotW);
      const totalCandles = displayCandles.length;

      // Index of the last candle on screen
      const lastCandleIndex = totalCandles - 1 + Math.round(vs.panOffsetCandles);
      const rightMostSlotIndex = visibleSlots - vs.rightOffsetSlots;

      const indexToX = (idx: number) => {
        const slot = rightMostSlotIndex - (lastCandleIndex - idx);
        return slot * slotW + slotW * 0.5;
      };

      const timeToX = (timeSec: number) => {
        if (totalCandles === 0) return plotW * 0.6;
        const lastTime = displayCandles[totalCandles - 1].time;
        const diffCandles = (timeSec - lastTime) / tfSec;
        return indexToX(totalCandles - 1 + diffCandles);
      };

      const xToTime = (x: number) => {
        if (totalCandles === 0) return Math.floor(Date.now() / 1000);
        const lastTime = displayCandles[totalCandles - 1].time;
        const lastX = indexToX(totalCandles - 1);
        const diffCandles = (x - lastX) / slotW;
        return Math.round(lastTime + diffCandles * tfSec);
      };

      // Visible candle slice for Y-scale auto-fit
      const firstVisibleIdx = Math.max(0, Math.floor(lastCandleIndex - rightMostSlotIndex) - 2);
      const endVisibleIdx = Math.min(totalCandles - 1, lastCandleIndex + vs.rightOffsetSlots);

      let minPrice = Infinity;
      let maxPrice = -Infinity;

      for (let i = firstVisibleIdx; i <= endVisibleIdx; i++) {
        const c = displayCandles[i];
        if (!c) continue;
        if (c.low < minPrice) minPrice = c.low;
        if (c.high > maxPrice) maxPrice = c.high;
      }

      // Include live quote & active trades for visible range
      const livePrice = quote?.price ?? (totalCandles > 0 ? displayCandles[totalCandles - 1].close : 0);
      if (livePrice > 0) {
        if (livePrice < minPrice) minPrice = livePrice;
        if (livePrice > maxPrice) maxPrice = livePrice;
      }
      for (const tr of activeTrades) {
        if (tr.symbol === asset.symbol) {
          if (tr.entryPrice < minPrice) minPrice = tr.entryPrice;
          if (tr.entryPrice > maxPrice) maxPrice = tr.entryPrice;
        }
      }

      if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice)) {
        minPrice = 0;
        maxPrice = 100;
      }
      if (maxPrice === minPrice) {
        const pad = maxPrice * 0.002 || 1;
        minPrice -= pad;
        maxPrice += pad;
      }

      const rawRange = maxPrice - minPrice;
      minPrice -= rawRange * 0.14;
      maxPrice += rawRange * 0.14;
      const priceRange = maxPrice - minPrice;

      const priceToY = (p: number) => {
        return plotH - ((p - minPrice) / priceRange) * plotH;
      };
      const yToPrice = (y: number) => {
        return minPrice + ((plotH - y) / plotH) * priceRange;
      };

      // Clip main plot area
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotW, plotH);
      ctx.clip();

      // Round-number horizontal price grid lines (institutional broker style)
      const roundLevels = computeNicePriceLevels(minPrice, maxPrice, 7);
      const gridColor = isChartDark ? 'rgba(148, 163, 184, 0.08)' : 'rgba(148, 163, 184, 0.2)';
      const majorGridColor = isChartDark ? 'rgba(148, 163, 184, 0.16)' : 'rgba(148, 163, 184, 0.34)';
      if (settings.showGrid) {
        ctx.lineWidth = 1;
        for (let i = 0; i < roundLevels.levels.length; i++) {
          const lvl = roundLevels.levels[i];
          const y = Math.round(priceToY(lvl)) + 0.5;
          if (y < 8 || y > plotH - 8) continue;
          const isMajor = Math.abs(Math.round(lvl / roundLevels.majorStep) * roundLevels.majorStep - lvl) < roundLevels.step * 0.01;
          ctx.strokeStyle = isMajor ? majorGridColor : gridColor;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(plotW, y);
          ctx.stroke();
        }
      }

      // Vertical time grid
      const labelEvery = Math.max(4, Math.floor(85 / slotW));
      const vGridPoints: { x: number; time: number }[] = [];
      for (let i = firstVisibleIdx; i <= endVisibleIdx + vs.rightOffsetSlots; i++) {
        if (i % labelEvery === 0) {
          const x = indexToX(i);
          if (x >= 0 && x <= plotW) {
            const cTime =
              i >= 0 && i < totalCandles
                ? displayCandles[i].time
                : totalCandles > 0
                  ? displayCandles[totalCandles - 1].time + (i - (totalCandles - 1)) * tfSec
                  : Math.floor(Date.now() / 1000);
            vGridPoints.push({ x, time: cTime });
            if (settings.showGrid) {
              ctx.strokeStyle = gridColor;
              ctx.beginPath();
              ctx.moveTo(Math.round(x) + 0.5, 0);
              ctx.lineTo(Math.round(x) + 0.5, plotH);
              ctx.stroke();
            }
          }
        }
      }

      // Hover UP / DOWN Zone Shading (Quotex signature interactive preview)
      if (hoverDirection && livePrice > 0) {
        const liveY = priceToY(livePrice);
        if (hoverDirection === 'UP') {
          const grad = ctx.createLinearGradient(0, 0, 0, liveY);
          grad.addColorStop(0, 'rgba(15, 175, 89, 0.02)');
          grad.addColorStop(1, 'rgba(15, 175, 89, 0.22)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, plotW, liveY);
        } else {
          const grad = ctx.createLinearGradient(0, liveY, 0, plotH);
          grad.addColorStop(0, 'rgba(255, 71, 87, 0.22)');
          grad.addColorStop(1, 'rgba(255, 71, 87, 0.02)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, liveY, plotW, plotH - liveY);
        }
      }

      // Render Price Series
      if (totalCandles > 0) {
        if (chartType === 'area') {
          // Smooth Area Line + Gradient Fill
          const pts: { x: number; y: number }[] = [];
          for (let i = Math.max(0, firstVisibleIdx); i <= Math.min(totalCandles - 1, endVisibleIdx); i++) {
            pts.push({ x: indexToX(i), y: priceToY(displayCandles[i].close) });
          }
          if (pts.length > 1) {
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              ctx.lineTo(pts[i].x, pts[i].y);
            }
            ctx.strokeStyle = '#38BDF8';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.lineTo(pts[pts.length - 1].x, plotH);
            ctx.lineTo(pts[0].x, plotH);
            ctx.closePath();
            const areaGrad = ctx.createLinearGradient(0, 0, 0, plotH);
            areaGrad.addColorStop(0, 'rgba(56, 189, 248, 0.28)');
            areaGrad.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
            ctx.fillStyle = areaGrad;
            ctx.fill();
          }
        } else if (chartType === 'bars') {
          const barHalf = Math.max(2, slotW * 0.3);
          for (let i = Math.max(0, firstVisibleIdx); i <= Math.min(totalCandles - 1, endVisibleIdx); i++) {
            const c = displayCandles[i];
            const x = indexToX(i);
            const isUp = c.close >= c.open;
            ctx.strokeStyle = isUp ? '#0FAF59' : '#FF4757';
            ctx.lineWidth = Math.max(1.2, slotW * 0.14);
            ctx.beginPath();
            ctx.moveTo(x, priceToY(c.high));
            ctx.lineTo(x, priceToY(c.low));
            ctx.moveTo(x - barHalf, priceToY(c.open));
            ctx.lineTo(x, priceToY(c.open));
            ctx.moveTo(x, priceToY(c.close));
            ctx.lineTo(x + barHalf, priceToY(c.close));
            ctx.stroke();
          }
        } else {
          // Candlesticks or Heikin Ashi (exact vibrant Quotex green & coral-red)
          const bodyW = Math.max(3, Math.floor(slotW * 0.7));
          for (let i = Math.max(0, firstVisibleIdx); i <= Math.min(totalCandles - 1, endVisibleIdx); i++) {
            const c = displayCandles[i];
            const x = indexToX(i);
            const isUp = c.close >= c.open;
            const color = isUp ? '#10B965' : '#F86056';

            const yHigh = priceToY(c.high);
            const yLow = priceToY(c.low);
            const yOpen = priceToY(c.open);
            const yClose = priceToY(c.close);

            // Wick
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(x, yHigh);
            ctx.lineTo(x, yLow);
            ctx.stroke();

            // Body
            const top = Math.min(yOpen, yClose);
            const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
            ctx.fillStyle = color;
            ctx.fillRect(Math.round(x - bodyW / 2), top, bodyW, bodyH);
          }
        }
      }

      // Overlay Technical Indicators (SMA, EMA, Bollinger Bands)
      for (const ind of indicators) {
        if (!ind.enabled) continue;
        if (ind.id === 'sma') {
          const vals = computeSMA(displayCandles, ind.period);
          drawOverlayLine(ctx, vals, firstVisibleIdx, endVisibleIdx, indexToX, priceToY, ind.color, 1.5);
        } else if (ind.id === 'ema') {
          const vals = computeEMA(displayCandles, ind.period);
          drawOverlayLine(ctx, vals, firstVisibleIdx, endVisibleIdx, indexToX, priceToY, ind.color, 1.5);
        } else if (ind.id === 'bollinger') {
          const bb = computeBollingerBands(displayCandles, ind.period, 2);
          drawOverlayLine(ctx, bb.upper, firstVisibleIdx, endVisibleIdx, indexToX, priceToY, ind.color, 1.2);
          drawOverlayLine(ctx, bb.middle, firstVisibleIdx, endVisibleIdx, indexToX, priceToY, 'rgba(167,139,250,0.6)', 1);
          drawOverlayLine(ctx, bb.lower, firstVisibleIdx, endVisibleIdx, indexToX, priceToY, ind.color, 1.2);
        }
      }

      // Render User Drawings
      const allDrawings = [...drawings];
      if (vs.draftPoint && vs.mouseX >= 0 && vs.mouseY >= 0 && activeTool !== 'crosshair') {
        allDrawings.push({
          id: '__draft__',
          symbol: asset.symbol,
          tool: activeTool,
          points: [vs.draftPoint, { time: xToTime(vs.mouseX), price: yToPrice(vs.mouseY) }],
          color: '#38BDF8',
        });
      }

      for (const drw of allDrawings) {
        if (drw.symbol !== asset.symbol) continue;
        ctx.strokeStyle = drw.color;
        ctx.lineWidth = 1.6;
        const p1 = drw.points[0];
        const p2 = drw.points[1];
        if (!p1) continue;
        const x1 = timeToX(p1.time);
        const y1 = priceToY(p1.price);

        if (drw.tool === 'horizontal') {
          ctx.beginPath();
          ctx.moveTo(0, y1);
          ctx.lineTo(plotW, y1);
          ctx.stroke();
          ctx.fillStyle = drw.color;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText(p1.price.toFixed(asset.decimals), 8, y1 - 4);
        } else if (drw.tool === 'vertical') {
          ctx.beginPath();
          ctx.moveTo(x1, 0);
          ctx.lineTo(x1, plotH);
          ctx.stroke();
        } else if (drw.tool === 'trendline' && p2) {
          const x2 = timeToX(p2.time);
          const y2 = priceToY(p2.price);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        } else if (drw.tool === 'ray' && p2) {
          const x2 = timeToX(p2.time);
          const y2 = priceToY(p2.price);
          const dx = x2 - x1;
          const dy = y2 - y1;
          const factor = dx !== 0 ? (plotW - x1) / dx : 10;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 + dx * Math.max(1, factor), y1 + dy * Math.max(1, factor));
          ctx.stroke();
        } else if (drw.tool === 'rectangle' && p2) {
          const x2 = timeToX(p2.time);
          const y2 = priceToY(p2.price);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.1)';
          ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        } else if (drw.tool === 'fibonacci' && p2) {
          const x2 = timeToX(p2.time);
          const y2 = priceToY(p2.price);
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 1];
          const left = Math.min(x1, x2);
          const right = Math.max(x1, x2, left + 120);
          ctx.font = '500 10px "JetBrains Mono", monospace';
          for (const lvl of levels) {
            const ly = y1 + (y2 - y1) * lvl;
            ctx.strokeStyle = lvl === 0.618 || lvl === 0.5 ? '#F59E0B' : 'rgba(56, 189, 248, 0.7)';
            ctx.beginPath();
            ctx.moveTo(left, ly);
            ctx.lineTo(right, ly);
            ctx.stroke();
            ctx.fillStyle = '#94A3B8';
            ctx.fillText(`${(lvl * 100).toFixed(1)}%`, left + 4, ly - 3);
          }
        }
      }

      // Upcoming Projected Expiry Vertical Line (Quotex "Beginning of trade / End of trade" style)
      const nowSec = Date.now() / 1000;
      const projExpiryX = timeToX(nowSec + selectedDurationSec);
      if (projExpiryX > 0 && projExpiryX < plotW) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(projExpiryX, 0);
        ctx.lineTo(projExpiryX, plotH);
        ctx.stroke();
        ctx.restore();

        const m = Math.floor(selectedDurationSec / 60);
        const s = selectedDurationSec % 60;
        const timerStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

        ctx.font = '500 10px "Plus Jakarta Sans", sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.textAlign = 'right';
        ctx.fillText('Beginning of trade ▸', projExpiryX - 8, 18);
        ctx.textAlign = 'left';
        ctx.fillText('◂ End of trade', projExpiryX + 8, 18);
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.fillText(timerStr, projExpiryX + 16, 32);
      }

      // Active Trades Overlay on Chart
      if (settings.showOpenTradesOnChart) {
        const nowMs = Date.now();
        for (const tr of activeTrades) {
          if (tr.symbol !== asset.symbol) continue;
          const entryY = priceToY(tr.entryPrice);
          const entryX = timeToX(tr.entryTime / 1000);
          const expX = timeToX(tr.expiryTime / 1000);

          const isWinning =
            (tr.direction === 'UP' && livePrice > tr.entryPrice) ||
            (tr.direction === 'DOWN' && livePrice < tr.entryPrice);
          const tradeColor = tr.direction === 'UP' ? '#0FAF59' : '#FF4757';

          // Horizontal Strike Line
          ctx.save();
          ctx.setLineDash([5, 3]);
          ctx.strokeStyle = tradeColor;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(Math.max(0, entryX), entryY);
          ctx.lineTo(plotW, entryY);
          ctx.stroke();

          // Vertical Expiry Line
          if (expX > 0 && expX < plotW) {
            ctx.strokeStyle = '#F59E0B';
            ctx.beginPath();
            ctx.moveTo(expX, 0);
            ctx.lineTo(expX, plotH);
            ctx.stroke();

            const remSec = Math.max(0, Math.ceil((tr.expiryTime - nowMs) / 1000));
            ctx.fillStyle = '#F59E0B';
            ctx.fillRect(expX - 24, plotH - 22, 48, 18);
            ctx.fillStyle = '#0F172A';
            ctx.font = '700 10px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${remSec}s`, expX, plotH - 9);
            ctx.textAlign = 'left';
          }
          ctx.restore();

          // Entry Badge
          const badgeX = Math.max(12, Math.min(plotW - 150, entryX));
          const badgeText = `${tr.direction === 'UP' ? '▲' : '▼'} $${tr.amount} · ${isWinning ? 'IN PROFIT' : 'OUT'}`;
          ctx.font = '600 11px "JetBrains Mono", monospace';
          const tw = ctx.measureText(badgeText).width + 16;
          ctx.fillStyle = isWinning ? '#0FAF59' : '#334155';
          ctx.fillRect(badgeX, entryY - 11, tw, 22);
          ctx.strokeStyle = tradeColor;
          ctx.lineWidth = 1;
          ctx.strokeRect(badgeX, entryY - 11, tw, 22);
          ctx.fillStyle = '#FFFFFF';
          ctx.fillText(badgeText, badgeX + 8, entryY + 4);
        }

        // Pending Orders Target Lines
        for (const po of pendingOrders) {
          if (po.symbol !== asset.symbol || po.status !== 'pending') continue;
          if (po.triggerType === 'price' && po.targetPrice) {
            const py = priceToY(po.targetPrice);
            ctx.save();
            ctx.setLineDash([3, 3]);
            ctx.strokeStyle = '#F59E0B';
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.moveTo(0, py);
            ctx.lineTo(plotW, py);
            ctx.stroke();
            ctx.restore();
            ctx.fillStyle = '#F59E0B';
            ctx.font = '600 10px "JetBrains Mono", monospace';
            ctx.fillText(
              `PENDING ${po.direction} $${po.amount} @ ${po.targetPrice.toFixed(asset.decimals)}`,
              12,
              py - 5
            );
          }
        }
      }

      // Live Spot Price Horizontal Line & Glowing Head Dot
      const lastCandle = totalCandles > 0 ? displayCandles[totalCandles - 1] : null;
      const isLiveBullish = lastCandle ? lastCandle.close >= lastCandle.open : true;
      const liveRayColor = chartType === 'area' ? '#2962FF' : isLiveBullish ? '#0FAF59' : '#FF4757';

      if (livePrice > 0 && totalCandles > 0) {
        const liveY = Math.round(priceToY(livePrice)) + 0.5;
        const lastCandleX = indexToX(totalCandles - 1);

        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = liveRayColor;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, liveY);
        ctx.lineTo(plotW, liveY);
        ctx.stroke();
        ctx.restore();

        // Pulsing dot at live candle tip
        const pulse = (Math.sin(Date.now() / 180) + 1) / 2;
        ctx.beginPath();
        ctx.arc(lastCandleX, liveY, 5 + pulse * 4, 0, Math.PI * 2);
        ctx.fillStyle =
          chartType === 'area'
            ? `rgba(41, 98, 255, ${0.35 - pulse * 0.25})`
            : isLiveBullish
              ? `rgba(15, 175, 89, ${0.35 - pulse * 0.25})`
              : `rgba(255, 71, 87, ${0.35 - pulse * 0.25})`;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(lastCandleX, liveY, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
      }

      // Crosshair lines inside plot
      if (vs.mouseX >= 0 && vs.mouseX <= plotW && vs.mouseY >= 0 && vs.mouseY <= plotH) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = isChartDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(15, 23, 42, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, vs.mouseY);
        ctx.lineTo(plotW, vs.mouseY);
        ctx.moveTo(vs.mouseX, 0);
        ctx.lineTo(vs.mouseX, plotH);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore(); // end main plot clip

      // ==========================================
      // OSCILLATOR SUB-PANES (RSI / MACD / STOCHASTIC)
      // ==========================================
      let currentTop = plotH;
      for (const osc of activeOscillators) {
        const subH = 86;
        ctx.fillStyle = isChartDark ? '#10141E' : '#F8FAFC';
        ctx.fillRect(0, currentTop, plotW, subH);
        ctx.strokeStyle = isChartDark ? '#232938' : '#E2E8F0';
        ctx.beginPath();
        ctx.moveTo(0, currentTop + 0.5);
        ctx.lineTo(width, currentTop + 0.5);
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, currentTop, plotW, subH);
        ctx.clip();

        if (osc.id === 'rsi') {
          const rsiVals = computeRSI(displayCandles, osc.period || 14);
          const y70 = currentTop + subH - (70 / 100) * (subH - 16) - 8;
          const y30 = currentTop + subH - (30 / 100) * (subH - 16) - 8;
          ctx.fillStyle = 'rgba(244, 114, 182, 0.06)';
          ctx.fillRect(0, y70, plotW, y30 - y70);

          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = 'rgba(148, 163, 184, 0.3)';
          ctx.beginPath();
          ctx.moveTo(0, y70);
          ctx.lineTo(plotW, y70);
          ctx.moveTo(0, y30);
          ctx.lineTo(plotW, y30);
          ctx.stroke();
          ctx.setLineDash([]);

          drawOverlayLine(
            ctx,
            rsiVals,
            firstVisibleIdx,
            endVisibleIdx,
            indexToX,
            (v) => currentTop + subH - (v / 100) * (subH - 16) - 8,
            osc.color,
            1.5
          );
          const lastRsi = rsiVals[rsiVals.length - 1];
          ctx.fillStyle = osc.color;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText(`RSI(${osc.period}) ${lastRsi !== null ? lastRsi.toFixed(1) : '--'}`, 10, currentTop + 14);
        } else if (osc.id === 'stochastic') {
          const st = computeStochastic(displayCandles, osc.period || 14, 3);
          drawOverlayLine(
            ctx,
            st.k,
            firstVisibleIdx,
            endVisibleIdx,
            indexToX,
            (v) => currentTop + subH - (v / 100) * (subH - 16) - 8,
            '#10B981',
            1.4
          );
          drawOverlayLine(
            ctx,
            st.d,
            firstVisibleIdx,
            endVisibleIdx,
            indexToX,
            (v) => currentTop + subH - (v / 100) * (subH - 16) - 8,
            '#F59E0B',
            1.2
          );
          ctx.fillStyle = '#10B981';
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText(`Stoch(${osc.period},3)`, 10, currentTop + 14);
        } else if (osc.id === 'macd') {
          const mc = computeMACD(displayCandles, 12, 26, 9);
          let maxAbs = 0.000001;
          for (let i = Math.max(0, firstVisibleIdx); i <= Math.min(totalCandles - 1, endVisibleIdx); i++) {
            const v1 = Math.abs(mc.macd[i] ?? 0);
            const v2 = Math.abs(mc.signal[i] ?? 0);
            const v3 = Math.abs(mc.histogram[i] ?? 0);
            maxAbs = Math.max(maxAbs, v1, v2, v3);
          }
          const midY = currentTop + subH / 2;
          const mapMacdY = (v: number) => midY - (v / maxAbs) * (subH * 0.38);

          const barW = Math.max(2, slotW * 0.55);
          for (let i = Math.max(0, firstVisibleIdx); i <= Math.min(totalCandles - 1, endVisibleIdx); i++) {
            const h = mc.histogram[i];
            if (h === null) continue;
            const x = indexToX(i);
            const y = mapMacdY(h);
            ctx.fillStyle = h >= 0 ? 'rgba(15, 175, 89, 0.55)' : 'rgba(255, 71, 87, 0.55)';
            ctx.fillRect(x - barW / 2, Math.min(midY, y), barW, Math.max(1, Math.abs(y - midY)));
          }
          drawOverlayLine(ctx, mc.macd, firstVisibleIdx, endVisibleIdx, indexToX, mapMacdY, '#38BDF8', 1.3);
          drawOverlayLine(ctx, mc.signal, firstVisibleIdx, endVisibleIdx, indexToX, mapMacdY, '#F59E0B', 1.2);
          ctx.fillStyle = '#38BDF8';
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText('MACD(12,26,9)', 10, currentTop + 14);
        }
        ctx.restore();

        ctx.fillStyle = isChartDark ? '#131722' : '#FFFFFF';
        ctx.fillRect(plotW, currentTop, rightAxisW, subH);
        currentTop += subH;
      }

      // ==========================================
      // RIGHT PRICE AXIS & BOTTOM TIME AXIS
      // ==========================================
      ctx.fillStyle = isChartDark ? '#131722' : '#FFFFFF';
      ctx.fillRect(plotW, 0, rightAxisW, plotH);

      ctx.strokeStyle = isChartDark ? '#232938' : '#E2E8F0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(plotW + 0.5, 0);
      ctx.lineTo(plotW + 0.5, height - bottomAxisH);
      ctx.moveTo(0, height - bottomAxisH + 0.5);
      ctx.lineTo(width, height - bottomAxisH + 0.5);
      ctx.stroke();

      // Right price labels snapped to exact round numbers
      ctx.fillStyle = isChartDark ? '#78859B' : '#64748B';
      ctx.font = '500 11px "JetBrains Mono", monospace';
      for (const lvl of roundLevels.levels) {
        const y = priceToY(lvl);
        if (y < 14 || y > plotH - 14) continue;
        ctx.fillText(lvl.toFixed(asset.decimals), plotW + 8, y + 4);
      }

      // Candle-Close Timer pill near live candle + Blue Live Price Pill on right axis (Exact Screenshot 2 Style!)
      if (livePrice > 0 && totalCandles > 0) {
        const liveY = Math.max(16, Math.min(plotH - 16, priceToY(livePrice)));
        const nowUnixSec = Math.floor(Date.now() / 1000);
        const candleCloseRemaining = Math.max(0, tfSec - (nowUnixSec % tfSec));
        const cm = Math.floor(candleCloseRemaining / 60);
        const cs = candleCloseRemaining % 60;
        const candleTimerStr = `${String(cm).padStart(2, '0')}:${String(cs).padStart(2, '0')}`;
        const priceStr = livePrice.toFixed(asset.decimals);

        // Small neutral timer pill right beside active candle
        const lastX = indexToX(totalCandles - 1);
        const timerX = Math.min(plotW - 56, Math.max(24, lastX + 14));
        ctx.fillStyle = isChartDark ? '#252B3B' : '#CBD5E1';
        roundRect(ctx, timerX, liveY - 9, 42, 18, 4);
        ctx.fill();
        ctx.fillStyle = isChartDark ? '#E2E8F0' : '#334155';
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(candleTimerStr, timerX + 21, liveY + 3.5);

        // Bright blue live price pill anchored on right price axis
        ctx.font = '700 11px "JetBrains Mono", monospace';
        const priceW = Math.max(66, ctx.measureText(priceStr).width + 14);
        const priceX = width - priceW - 4;
        ctx.fillStyle = '#1D74F5';
        roundRect(ctx, priceX, liveY - 10, priceW, 20, 10);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(priceStr, priceX + priceW / 2, liveY + 4);
        ctx.textAlign = 'left';
      }

      // Crosshair Price Tag on Right Axis
      if (vs.mouseY >= 0 && vs.mouseY <= plotH && vs.mouseX >= 0 && vs.mouseX <= plotW) {
        const hoverPrice = yToPrice(vs.mouseY);
        ctx.fillStyle = isChartDark ? '#334155' : '#1E293B';
        ctx.fillRect(plotW + 2, vs.mouseY - 10, rightAxisW - 4, 20);
        ctx.fillStyle = '#F8FAFC';
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.fillText(hoverPrice.toFixed(asset.decimals), plotW + 8, vs.mouseY + 4);
      }

      // Bottom Time Axis
      ctx.fillStyle = isChartDark ? '#131722' : '#FFFFFF';
      ctx.fillRect(0, height - bottomAxisH + 1, width, bottomAxisH - 1);
      ctx.fillStyle = isChartDark ? '#64748B' : '#64748B';
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      for (const vp of vGridPoints) {
        ctx.fillText(formatTimeLabel(vp.time), vp.x, height - 9);
      }

      // Crosshair Time Tag
      if (vs.mouseX >= 0 && vs.mouseX <= plotW && vs.mouseY >= 0 && vs.mouseY <= height - bottomAxisH) {
        const hoverTime = xToTime(vs.mouseX);
        const tLabel = formatTimeLabel(hoverTime, true);
        const tw = ctx.measureText(tLabel).width + 14;
        ctx.fillStyle = isChartDark ? '#334155' : '#1E293B';
        ctx.fillRect(vs.mouseX - tw / 2, height - bottomAxisH + 3, tw, 20);
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(tLabel, vs.mouseX, height - 9);
      }
      ctx.textAlign = 'left';

      // Top-left OHLC Readout (only shown on crosshair hover to keep chart ultra-clean like Screenshot 2)
      if (totalCandles > 0 && vs.mouseX >= 0 && vs.mouseX <= plotW) {
        const lastX = indexToX(totalCandles - 1);
        const idx = Math.round(totalCandles - 1 + (vs.mouseX - lastX) / slotW);
        if (idx >= 0 && idx < totalCandles) {
          const targetCandle = displayCandles[idx];
          const isUp = targetCandle.close >= targetCandle.open;
          ctx.font = '500 10px "JetBrains Mono", monospace';
          ctx.fillStyle = isChartDark ? '#94A3B8' : '#64748B';
          const d = asset.decimals;
          const ohlc = `O ${targetCandle.open.toFixed(d)}  H ${targetCandle.high.toFixed(d)}  L ${targetCandle.low.toFixed(d)}  C ${targetCandle.close.toFixed(d)}`;
          ctx.fillText(ohlc, 34, 72);
          ctx.fillStyle = isUp ? '#10B965' : '#F86056';
          const diff = targetCandle.close - targetCandle.open;
          ctx.fillText(`${diff >= 0 ? '+' : ''}${diff.toFixed(d)}`, 34 + ctx.measureText(ohlc).width + 10, 72);
        }
      }

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [
    asset,
    quote,
    candles,
    timeframe,
    chartType,
    indicators,
    activeTrades,
    pendingOrders,
    hoverDirection,
    selectedDurationSec,
    settings,
    drawings,
    activeTool,
    formatTimeLabel,
    getLayoutMetrics,
  ]);

  // Pointer & Wheel handlers
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const vs = viewStateRef.current;
    vs.mouseX = x;
    vs.mouseY = y;

    if (vs.isDragging) {
      const dx = x - vs.dragStartX;
      vs.panOffsetCandles = Math.max(-candles.length + 10, Math.min(40, vs.dragStartPan + dx / vs.candleWidth));
    }
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const vs = viewStateRef.current;

    const { plotW, plotH } = getLayoutMetrics(rect.width, rect.height);
    if (x > plotW || y > plotH) return;

    if (activeTool === 'crosshair') {
      vs.isDragging = true;
      vs.dragStartX = x;
      vs.dragStartPan = vs.panOffsetCandles;
      return;
    }

    // Drawing mode: convert x, y to (time, price)
    const displayCandles = chartType === 'heikin_ashi' ? toHeikinAshi(candles) : candles;
    const totalCandles = displayCandles.length;
    if (totalCandles === 0) return;

    const slotW = vs.candleWidth;
    const visibleSlots = Math.floor(plotW / slotW);
    const lastCandleIndex = totalCandles - 1 + Math.round(vs.panOffsetCandles);
    const rightMostSlotIndex = visibleSlots - vs.rightOffsetSlots;
    const indexToX = (idx: number) => (rightMostSlotIndex - (lastCandleIndex - idx)) * slotW + slotW * 0.5;
    const lastX = indexToX(totalCandles - 1);
    const tfSec = TIMEFRAME_SECONDS[timeframe] || 60;
    const clickedTime = Math.round(displayCandles[totalCandles - 1].time + ((x - lastX) / slotW) * tfSec);

    // Recompute current visible min/max price
    const firstVisibleIdx = Math.max(0, Math.floor(lastCandleIndex - rightMostSlotIndex) - 2);
    const endVisibleIdx = Math.min(totalCandles - 1, lastCandleIndex + vs.rightOffsetSlots);
    let minPrice = Infinity;
    let maxPrice = -Infinity;
    for (let i = firstVisibleIdx; i <= endVisibleIdx; i++) {
      const c = displayCandles[i];
      if (!c) continue;
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }
    const livePrice = quote?.price ?? displayCandles[totalCandles - 1].close;
    if (livePrice < minPrice) minPrice = livePrice;
    if (livePrice > maxPrice) maxPrice = livePrice;
    const rawRange = maxPrice - minPrice || 1;
    minPrice -= rawRange * 0.14;
    maxPrice += rawRange * 0.14;
    const clickedPrice = minPrice + ((plotH - y) / plotH) * (maxPrice - minPrice);
    const point: DrawingPoint = { time: clickedTime, price: clickedPrice };

    if (activeTool === 'horizontal' || activeTool === 'vertical') {
      onAddDrawing({
        id: `drw_${Date.now()}`,
        symbol: asset.symbol,
        tool: activeTool,
        points: [point],
        color: '#38BDF8',
      });
      setActiveTool('crosshair');
    } else if (!vs.draftPoint) {
      vs.draftPoint = point;
    } else {
      onAddDrawing({
        id: `drw_${Date.now()}`,
        symbol: asset.symbol,
        tool: activeTool,
        points: [vs.draftPoint, point],
        color: '#38BDF8',
      });
      vs.draftPoint = null;
      setActiveTool('crosshair');
    }
  };

  const handleMouseUp = () => {
    viewStateRef.current.isDragging = false;
  };

  const handleMouseLeave = () => {
    viewStateRef.current.isDragging = false;
    viewStateRef.current.mouseX = -1;
    viewStateRef.current.mouseY = -1;
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const vs = viewStateRef.current;
    const delta = e.deltaY > 0 ? -1 : 1;
    vs.candleWidth = Math.max(4, Math.min(28, vs.candleWidth + delta));
  };

  const zoomIn = () => {
    viewStateRef.current.candleWidth = Math.min(28, viewStateRef.current.candleWidth + 2);
  };
  const zoomOut = () => {
    viewStateRef.current.candleWidth = Math.max(4, viewStateRef.current.candleWidth - 2);
  };
  const resetView = () => {
    viewStateRef.current.candleWidth = 10;
    viewStateRef.current.panOffsetCandles = 0;
  };

  const buyPct = quote?.buySentiment ?? 54;
  const sellPct = 100 - buyPct;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none bg-white dark:bg-[#131722]"
    >
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        onMouseMove={handleMouseMove}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onWheel={handleWheel}
        className={`block w-full h-full ${activeTool === 'crosshair' ? 'cursor-crosshair' : 'cursor-cell'}`}
      />

      {/* Sentiment Vertical Gauge (Left edge, exact Screenshot 2 thin bar with 50% top label) */}
      {settings.showSentiment && (
        <div
          className="absolute left-2 top-3 bottom-12 flex flex-col items-center pointer-events-none z-10"
          title={`Trader Sentiment: ${buyPct}% Up / ${sellPct}% Down`}
        >
          <span className="text-[10px] font-mono-tabular font-bold text-slate-700 dark:text-slate-300 mb-1">
            {buyPct}%
          </span>
          <div className="w-[3px] flex-1 rounded-full overflow-hidden flex flex-col bg-slate-200 dark:bg-[#252B3B]">
            <div
              className="bg-[#E6493E] transition-all duration-300"
              style={{ height: `${sellPct}%` }}
            />
            <div
              className="bg-[#0FAF59] transition-all duration-300"
              style={{ height: `${buyPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Top-Left Live Timestamp & PAIR INFORMATION Pill */}
      <div className="absolute top-3 left-8 z-20 flex flex-col items-start gap-2">
        <div className="flex items-center gap-2 text-[11px] font-mono-tabular text-slate-600 dark:text-slate-300">
          <span className="w-2 h-2 rounded-full bg-[#0FAF59]" />
          <span className="font-semibold">{clockText}</span>
          <span className="text-slate-400 dark:text-slate-500">·</span>
          <span className="text-slate-500 dark:text-slate-400">{quote?.provider || 'Live Feed'}</span>
        </div>

        <div className="relative">
          <button
            onClick={() => setShowPairInfo((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[#EBF3FF] dark:bg-[#1E2A42] hover:bg-[#DCEAFE] dark:hover:bg-[#253452] text-[#1D74F5] dark:text-[#60A5FA] text-[11px] font-display font-bold tracking-wide transition-colors shadow-xs"
          >
            <Info className="w-3.5 h-3.5 fill-[#1D74F5] text-white dark:text-[#1E2A42]" />
            <span>PAIR INFORMATION</span>
          </button>

          {showPairInfo && (
            <div className="mt-2 w-72 bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-lg shadow-xl p-3.5 text-xs text-slate-700 dark:text-slate-300 space-y-2 z-30">
              <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-[#262D3F]">
                <div>
                  <div className="font-display font-bold text-sm text-slate-900 dark:text-white">{asset.symbol}</div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">{asset.name}</div>
                </div>
                <button
                  onClick={() => setShowPairInfo(false)}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono-tabular text-[11px]">
                <div>
                  <span className="text-slate-400 block">Payout</span>
                  <span className="font-bold text-[#0FAF59]">{asset.payout}%</span>
                </div>
                <div>
                  <span className="text-slate-400 block">24h Change</span>
                  <span className={`font-bold ${(quote?.changePct ?? 0) >= 0 ? 'text-[#0FAF59]' : 'text-[#E6493E]'}`}>
                    {(quote?.changePct ?? 0) >= 0 ? '+' : ''}
                    {(quote?.changePct ?? 0).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">24h High</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {quote?.high24h ? quote.high24h.toFixed(asset.decimals) : '--'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-400 block">24h Low</span>
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {quote?.low24h ? quote.low24h.toFixed(asset.decimals) : '--'}
                  </span>
                </div>
              </div>
              <div className="pt-1 border-t border-slate-100 dark:border-[#262D3F] text-[11px] text-slate-500 dark:text-slate-400">
                Schedule: {asset.marketHours === '24/7' ? '24/7 Continuous' : 'Global Market Hours'}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom-Left 4 Stacked Tool Buttons */}
      <div className="absolute left-8 bottom-10 z-20 flex flex-col gap-1.5">
        {/* 1. Drawing Tools */}
        <div className="relative">
          <button
            onClick={() => {
              setShowDrawingMenu((v) => !v);
              setShowTimeframeMenu(false);
              setShowChartTypeMenu(false);
              setShowIndicatorsMenu(false);
            }}
            title="Drawing Tools"
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              showDrawingMenu || activeTool !== 'crosshair'
                ? 'bg-[#2962FF] border-[#2962FF] text-white'
                : 'bg-[#EEF2F6] dark:bg-[#1C212D] hover:bg-slate-200 dark:hover:bg-[#252B3B] border-slate-200 dark:border-[#2A3142] text-slate-700 dark:text-slate-200'
            }`}
          >
            <Pencil className="w-4 h-4" />
          </button>

          {showDrawingMenu && (
            <div className="absolute left-11 bottom-0 w-52 bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-lg shadow-xl p-1.5 z-30 space-y-0.5">
              <div className="px-2 py-1 text-[11px] font-bold text-slate-400">Drawing Tools</div>
              {DRAWING_TOOLS.map((dt) => {
                const Icon = dt.icon;
                return (
                  <button
                    key={dt.id}
                    onClick={() => {
                      viewStateRef.current.draftPoint = null;
                      setActiveTool(dt.id);
                      setShowDrawingMenu(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs rounded transition-colors ${
                      activeTool === dt.id
                        ? 'bg-[#2962FF] text-white font-semibold'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#252B3B]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{dt.label}</span>
                  </button>
                );
              })}
              <div className="border-t border-slate-100 dark:border-[#262D3F] my-1 pt-1 flex gap-1">
                <button
                  onClick={() => {
                    onUndoDrawing();
                    setShowDrawingMenu(false);
                  }}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-[#252B3B] rounded"
                >
                  <Undo2 className="w-3.5 h-3.5" /> Undo
                </button>
                <button
                  onClick={() => {
                    onClearDrawings();
                    setShowDrawingMenu(false);
                  }}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Clear
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 2. Timeframe Button */}
        <div className="relative">
          <button
            onClick={() => {
              setShowTimeframeMenu((v) => !v);
              setShowDrawingMenu(false);
              setShowChartTypeMenu(false);
              setShowIndicatorsMenu(false);
            }}
            title="Chart Timeframe"
            className={`w-9 h-9 rounded-md flex items-center justify-center border font-mono-tabular text-xs font-bold transition-colors ${
              showTimeframeMenu
                ? 'bg-[#2962FF] border-[#2962FF] text-white'
                : 'bg-[#EEF2F6] dark:bg-[#1C212D] hover:bg-slate-200 dark:hover:bg-[#252B3B] border-slate-200 dark:border-[#2A3142] text-slate-800 dark:text-slate-100'
            }`}
          >
            {timeframe}
          </button>

          {showTimeframeMenu && (
            <div className="absolute left-11 bottom-0 w-44 bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-lg shadow-xl p-2 z-30">
              <div className="text-[11px] font-bold text-slate-400 mb-1.5">Candle Timeframe</div>
              <div className="grid grid-cols-4 gap-1">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    onClick={() => {
                      onTimeframeChange(tf);
                      setShowTimeframeMenu(false);
                    }}
                    className={`py-1.5 text-xs font-mono-tabular font-semibold rounded transition-colors ${
                      timeframe === tf
                        ? 'bg-[#2962FF] text-white'
                        : 'bg-slate-100 dark:bg-[#252B3B] text-slate-700 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-[#31384D]'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 3. Chart Type Button */}
        <div className="relative">
          <button
            onClick={() => {
              setShowChartTypeMenu((v) => !v);
              setShowTimeframeMenu(false);
              setShowDrawingMenu(false);
              setShowIndicatorsMenu(false);
            }}
            title="Chart Type"
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              showChartTypeMenu
                ? 'bg-[#2962FF] border-[#2962FF] text-white'
                : 'bg-[#EEF2F6] dark:bg-[#1C212D] hover:bg-slate-200 dark:hover:bg-[#252B3B] border-slate-200 dark:border-[#2A3142] text-slate-700 dark:text-slate-200'
            }`}
          >
            {chartType === 'area' && <Activity className="w-4 h-4" />}
            {chartType === 'candles' && <CandlestickChart className="w-4 h-4" />}
            {chartType === 'bars' && <BarChart2 className="w-4 h-4" />}
            {chartType === 'heikin_ashi' && <TrendingUp className="w-4 h-4" />}
          </button>

          {showChartTypeMenu && (
            <div className="absolute left-11 bottom-0 w-44 bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-lg shadow-xl p-1.5 z-30 space-y-0.5">
              <div className="px-2 py-1 text-[11px] font-bold text-slate-400">Chart Style</div>
              {(
                [
                  { id: 'candles', label: 'Candles', icon: CandlestickChart },
                  { id: 'area', label: 'Area', icon: Activity },
                  { id: 'bars', label: 'Bars', icon: BarChart2 },
                  { id: 'heikin_ashi', label: 'Heikin Ashi', icon: TrendingUp },
                ] as const
              ).map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onChartTypeChange(item.id);
                      setShowChartTypeMenu(false);
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 text-xs rounded transition-colors ${
                      chartType === item.id
                        ? 'bg-[#2962FF] text-white font-semibold'
                        : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#252B3B]'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 4. Indicators Button */}
        <div className="relative">
          <button
            onClick={() => {
              setShowIndicatorsMenu((v) => !v);
              setShowChartTypeMenu(false);
              setShowTimeframeMenu(false);
              setShowDrawingMenu(false);
            }}
            title="Technical Indicators"
            className={`w-9 h-9 rounded-md flex items-center justify-center border transition-colors ${
              showIndicatorsMenu || indicators.filter((i) => i.enabled).length > 0
                ? 'bg-[#2962FF] border-[#2962FF] text-white'
                : 'bg-[#EEF2F6] dark:bg-[#1C212D] hover:bg-slate-200 dark:hover:bg-[#252B3B] border-slate-200 dark:border-[#2A3142] text-slate-700 dark:text-slate-200'
            }`}
          >
            <SlidersHorizontal className="w-4 h-4" />
          </button>

          {showIndicatorsMenu && (
            <div className="absolute left-11 bottom-0 w-72 bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-lg shadow-xl p-2.5 z-30">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-200 dark:border-[#262D3F]">
                <span className="text-xs font-semibold text-slate-900 dark:text-white">Technical Indicators</span>
                <button
                  onClick={() => setShowIndicatorsMenu(false)}
                  className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {indicators.length > 0 && (
                <div className="mb-2.5 space-y-1">
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Active on chart</div>
                  {indicators.map((ind) => (
                    <div
                      key={ind.uid}
                      className="flex items-center justify-between px-2 py-1.5 rounded bg-slate-100 dark:bg-[#252B3B] text-xs"
                    >
                      <button
                        onClick={() => onToggleIndicator(ind.uid)}
                        className="flex items-center gap-2 text-left flex-1 min-w-0"
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0"
                          style={{ backgroundColor: ind.enabled ? ind.color : '#64748B' }}
                        />
                        <span
                          className={`truncate ${
                            ind.enabled ? 'text-slate-900 dark:text-white font-medium' : 'text-slate-400 line-through'
                          }`}
                        >
                          {ind.name}
                        </span>
                      </button>
                      <button
                        onClick={() => onRemoveIndicator(ind.uid)}
                        className="text-slate-400 hover:text-rose-500 ml-2"
                        title="Remove indicator"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-1">
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Add Indicator</div>
                {INDICATOR_CATALOG.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => onAddIndicator(item.id)}
                    className="w-full flex items-center justify-between px-2 py-1.5 text-left rounded hover:bg-slate-100 dark:hover:bg-[#252B3B] transition-colors"
                  >
                    <div>
                      <div className="text-xs font-medium text-slate-800 dark:text-slate-200">{item.label}</div>
                      <div className="text-[10px] text-slate-500 dark:text-slate-400">{item.desc}</div>
                    </div>
                    <Plus className="w-3.5 h-3.5 text-[#2962FF]" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Center-Bottom Zoom Controls */}
      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#EEF2F6] dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-md p-0.5 shadow-sm z-20">
        <button
          onClick={zoomOut}
          title="Zoom Out"
          className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-[#252B3B] transition-colors"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={zoomIn}
          title="Zoom In"
          className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-[#252B3B] transition-colors"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={resetView}
          title="Reset Chart View"
          className="p-1.5 rounded text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-white dark:hover:bg-[#252B3B] transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Drawing Instruction Hint */}
      {activeTool !== 'crosshair' && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 bg-[#2962FF] text-white text-xs font-medium px-3 py-1 rounded shadow-md pointer-events-none">
          {activeTool === 'horizontal' || activeTool === 'vertical'
            ? `Click anywhere on chart to place ${activeTool} line`
            : viewStateRef.current.draftPoint
              ? `Click second point to finish ${activeTool}`
              : `Click start point on chart for ${activeTool}`}
        </div>
      )}

      {/* Loading State Overlay */}
      {loading && (
        <div className="absolute inset-0 bg-white/60 dark:bg-[#131722]/70 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
          <div className="bg-white dark:bg-[#1C212D] border border-slate-200 dark:border-[#2A3142] rounded-md px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 shadow-lg">
            Loading live {asset.symbol} ({timeframe}) market history...
          </div>
        </div>
      )}
    </div>
  );
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function computeNicePriceLevels(
  minPrice: number,
  maxPrice: number,
  targetTicks = 7
): { step: number; majorStep: number; levels: number[] } {
  const range = Math.max(1e-9, maxPrice - minPrice);
  const rawStep = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;

  let niceNorm = 1;
  if (norm <= 1) niceNorm = 1;
  else if (norm <= 2) niceNorm = 2;
  else if (norm <= 2.5) niceNorm = 2.5;
  else if (norm <= 5) niceNorm = 5;
  else niceNorm = 10;

  const step = niceNorm * mag;
  const majorStep = step * (niceNorm === 2.5 ? 2 : 5);
  const firstLevel = Math.ceil(minPrice / step) * step;
  const levels: number[] = [];
  for (let v = firstLevel; v <= maxPrice; v += step) {
    levels.push(Number(v.toPrecision(12)));
    if (levels.length > 30) break;
  }
  return { step, majorStep, levels };
}

function drawOverlayLine(
  ctx: CanvasRenderingContext2D,
  values: (number | null)[],
  firstIdx: number,
  endIdx: number,
  indexToX: (idx: number) => number,
  priceToY: (p: number) => number,
  color: string,
  lineWidth: number
) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  let started = false;
  for (let i = Math.max(0, firstIdx); i <= Math.min(values.length - 1, endIdx); i++) {
    const val = values[i];
    if (val === null || !Number.isFinite(val)) {
      started = false;
      continue;
    }
    const x = indexToX(i);
    const y = priceToY(val);
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.stroke();
  ctx.restore();
}
