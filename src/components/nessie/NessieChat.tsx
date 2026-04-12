/**
 * Nessie Chat Interface (NCE-11)
 *
 * Chat-style interface for asking Nessie compliance questions
 * with inline citations backed by anchored documents.
 *
 * Jira: SCRUM-602
 */

import { useState, useRef, useEffect } from 'react';
import { Send, Bot, User, AlertTriangle, Shield, Lightbulb, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { workerFetch } from '@/lib/workerClient';
import { CitationCard } from './CitationCard';

type QueryTask = 'compliance_qa' | 'risk_analysis' | 'recommendation';

interface Citation {
  record_id: string;
  title: string;
  source: string;
  source_url: string | null;
  anchor_status: string | null;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  task?: QueryTask;
  citations?: Citation[];
  confidence?: number;
  risks?: Array<{ level: string; description: string }>;
  loading?: boolean;
}

const TASK_OPTIONS: Array<{ value: QueryTask; label: string; icon: React.ReactNode }> = [
  { value: 'compliance_qa', label: 'Ask', icon: <Bot className="h-3 w-3" /> },
  { value: 'risk_analysis', label: 'Analyze Risk', icon: <AlertTriangle className="h-3 w-3" /> },
  { value: 'recommendation', label: 'Recommend', icon: <Lightbulb className="h-3 w-3" /> },
];

export function NessieChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [task, setTask] = useState<QueryTask>('compliance_qa');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    const query = input.trim();
    if (!query || sending) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: query,
      task,
    };

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: '',
      loading: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);

    try {
      const params = new URLSearchParams({
        q: query,
        mode: 'context',
        task,
        limit: '10',
      });

      const res = await workerFetch(`/api/v1/nessie/query?${params}`);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMessages(prev => prev.map(m =>
          m.id === assistantMsg.id
            ? { ...m, content: err.error || 'Failed to get response from Nessie.', loading: false }
            : m
        ));
        return;
      }

      const data = await res.json();

      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? {
              ...m,
              content: data.intelligence?.analysis ?? data.summary ?? 'No response generated.',
              citations: data.intelligence?.citations?.map((c: Record<string, unknown>) => ({
                record_id: c.record_id,
                title: c.title ?? 'Source Document',
                source: c.source ?? 'Unknown',
                source_url: c.source_url ?? null,
                anchor_status: c.anchor_status ?? null,
              })) ?? [],
              confidence: data.intelligence?.confidence ?? data.confidence?.overall ?? null,
              risks: data.intelligence?.risks ?? [],
              loading: false,
            }
          : m
      ));
    } catch (err) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, content: 'Network error. Please try again.', loading: false }
          : m
      ));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="flex flex-col h-[600px]">
      <CardHeader className="flex-shrink-0 pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Shield className="h-4 w-4 text-[#00d4ff]" />
          Ask Nessie
        </CardTitle>
      </CardHeader>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm space-y-2">
            <Bot className="h-8 w-8" />
            <p>Ask Nessie about compliance requirements, risks, or recommendations.</p>
          </div>
        )}
        {messages.map((msg) => (
          <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-[#00d4ff]/10 flex items-center justify-center">
                <Bot className="h-4 w-4 text-[#00d4ff]" />
              </div>
            )}
            <div className={`max-w-[80%] space-y-2 ${
              msg.role === 'user'
                ? 'bg-primary text-primary-foreground rounded-2xl rounded-tr-sm px-4 py-2'
                : 'bg-muted/50 rounded-2xl rounded-tl-sm px-4 py-3'
            }`}>
              {msg.loading ? (
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Analyzing...
                </div>
              ) : (
                <>
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>

                  {/* Confidence */}
                  {msg.confidence != null && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <span>Confidence:</span>
                      <span className={msg.confidence >= 0.85 ? 'text-emerald-500' : msg.confidence >= 0.65 ? 'text-amber-500' : 'text-red-500'}>
                        {Math.round(msg.confidence * 100)}%
                      </span>
                    </div>
                  )}

                  {/* Risk badges */}
                  {msg.risks && msg.risks.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {msg.risks.map((risk, i) => (
                        <Badge key={i} variant="outline" className={
                          risk.level === 'HIGH' ? 'border-red-300 text-red-600' :
                          risk.level === 'MEDIUM' ? 'border-amber-300 text-amber-600' :
                          'border-blue-300 text-blue-600'
                        }>
                          {risk.level}: {risk.description}
                        </Badge>
                      ))}
                    </div>
                  )}

                  {/* Citations */}
                  {msg.citations && msg.citations.length > 0 && (
                    <div className="space-y-1 pt-1">
                      {msg.citations.slice(0, 5).map((citation, i) => (
                        <CitationCard key={i} index={i + 1} citation={citation} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {msg.role === 'user' && (
              <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center">
                <User className="h-4 w-4 text-primary" />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="flex-shrink-0 p-4 border-t space-y-2">
        {/* Task selector */}
        <div className="flex gap-1">
          {TASK_OPTIONS.map(opt => (
            <Button
              key={opt.value}
              size="sm"
              variant={task === opt.value ? 'default' : 'ghost'}
              className="h-7 text-xs gap-1"
              onClick={() => setTask(opt.value)}
            >
              {opt.icon}
              {opt.label}
            </Button>
          ))}
        </div>

        {/* Input field */}
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
            placeholder="Ask Nessie about compliance..."
            className="flex-1 text-sm border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-[#00d4ff]/50"
            disabled={sending}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="gap-1"
          >
            <Send className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
