import {subscribe, unsubscribe} from 'node:diagnostics_channel';
import {IncomingMessage, ServerResponse} from 'node:http';
import {performance} from 'node:perf_hooks';
import {diag, DiagConsoleLogger, DiagLogLevel, SpanKind, SpanStatusCode} from '@opentelemetry/api';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {OTLPMetricExporter} from '@opentelemetry/exporter-metrics-otlp-http';
import {detectResources, envDetector, resourceFromAttributes} from '@opentelemetry/resources';
import {MeterProvider, PeriodicExportingMetricReader} from '@opentelemetry/sdk-metrics';
import {BatchSpanProcessor, NodeTracerProvider} from '@opentelemetry/sdk-trace-node';

const groups = new Set([
  'agents', 'badges', 'characters', 'connection', 'desktop', 'devices', 'firmware',
  'onboarding', 'orientation', 'service', 'usage', 'wifi',
]);

export function settingsTelemetryRoute(path: string): string | null {
  const pathname = path.split('?', 1)[0] ?? '';
  if (!pathname.startsWith('/api/')) return null;
  const group = pathname.split('/')[2];
  // Status polling and the long-lived event stream would obscure useful requests.
  if (group === 'status' || group === 'events') return null;
  return group && groups.has(group) ? `/api/${group}/*` : '/api/other';
}

export function startDevelopmentTelemetry(): {shutdown: () => Promise<void>} | undefined {
  if (process.env.AGENT_COMPANION_DEV !== '1' || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const endpoint = new URL(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  if (!['http:', 'https:'].includes(endpoint.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
    throw new Error('Development telemetry requires a loopback Aspire OTLP endpoint.');
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME ?? 'companion',
  }).merge(detectResources({detectors: [envDetector]}));
  const traces = new NodeTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(
      new OTLPTraceExporter({url: new URL('/v1/traces', endpoint).href}), {scheduledDelayMillis: 1000})],
  });
  const metrics = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({url: new URL('/v1/metrics', endpoint).href}), exportIntervalMillis: 5000,
    })],
  });
  const tracer = traces.getTracer('agent-buddy.development');
  const meter = metrics.getMeter('agent-buddy.development');
  const requests = meter.createCounter('settings.requests', {description: 'Completed Settings API requests'});
  const duration = meter.createHistogram('settings.request.duration', {unit: 's'});
  meter.createObservableGauge('process.memory.usage', {unit: 'By'}).addCallback(result => {
    result.observe(process.memoryUsage().rss);
  });
  meter.createObservableCounter('process.cpu.time', {unit: 's'}).addCallback(result => {
    const cpu = process.cpuUsage();
    result.observe(cpu.user / 1e6, {mode: 'user'});
    result.observe(cpu.system / 1e6, {mode: 'system'});
  });

  const observe = (message: unknown) => {
    if (!message || typeof message !== 'object' || !('request' in message) || !('response' in message)) return;
    const {request, response} = message;
    if (!(request instanceof IncomingMessage) || !(response instanceof ServerResponse)) return;
    const route = settingsTelemetryRoute(request.url ?? '');
    if (!route) return;
    const requestedMethod = request.method ?? '';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(requestedMethod)
      ? requestedMethod : 'OTHER';
    const attributes = {'http.request.method': method, 'http.route': route};
    const span = tracer.startSpan(`${method} ${route}`, {kind: SpanKind.SERVER, attributes});
    const start = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      response.off('finish', finish);
      response.off('close', finish);
      const status = response.writableFinished ? response.statusCode : 499;
      const completed = {...attributes, 'http.response.status_code': status};
      span.setAttributes(completed);
      if (status >= 500 || !response.writableFinished) span.setStatus({code: SpanStatusCode.ERROR});
      requests.add(1, completed);
      duration.record((performance.now() - start) / 1000, completed);
      span.end();
    };
    response.once('finish', finish);
    response.once('close', finish);
  };
  subscribe('http.server.request.start', observe);
  console.log('[dev] OpenTelemetry enabled: Settings API traces and request/runtime metrics');
  return {
    async shutdown() {
      unsubscribe('http.server.request.start', observe);
      await Promise.all([traces.shutdown(), metrics.shutdown()]);
    },
  };
}
