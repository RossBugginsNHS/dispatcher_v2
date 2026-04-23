export type CloudEvent<TData = Record<string, unknown>> = {
  id: string;
  source: string;
  type: string;
  subject: string;
  time: string;
  data: TData;
  appversion?: string;
  traceparent?: string;
  tracestate?: string;
};
