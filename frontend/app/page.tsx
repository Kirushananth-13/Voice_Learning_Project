'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Progress } from '@/components/ui/progress';
import { Navbar } from '@/components/navbar';
import { Mic, MicOff, Send, Loader2, MessageSquare, Radio } from 'lucide-react';

// Helpers
function base64ToArrayBuffer(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(binary);
}

// Dynamic imports for audio worklets
async function startAudioPlayerWorklet() {
  const audioContext = new AudioContext({ sampleRate: 24000 });
  // Files live under Next.js public/ as /audio/*
  const workletURL = new URL('/audio/pcm-player-processor.js', window.location.origin);
  await audioContext.audioWorklet.addModule(workletURL);
  const audioPlayerNode = new AudioWorkletNode(audioContext, 'pcm-player-processor');
  audioPlayerNode.connect(audioContext.destination);
  return [audioPlayerNode, audioContext] as const;
}

async function startAudioRecorderWorklet(audioRecorderHandler: (pcmData: ArrayBuffer) => void) {
  const audioRecorderContext = new AudioContext({ sampleRate: 16000 });
  console.log("AudioContext sample rate:", audioRecorderContext.sampleRate);
  
  // Files live under Next.js public/ as /audio/*
  const workletURL = new URL("/audio/pcm-recorder-processor.js", window.location.origin);
  await audioRecorderContext.audioWorklet.addModule(workletURL);
  
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1 },
  });
  const source = audioRecorderContext.createMediaStreamSource(micStream);
  
  const audioRecorderNode = new AudioWorkletNode(audioRecorderContext, "pcm-recorder-processor");
  
  source.connect(audioRecorderNode);
  audioRecorderNode.port.onmessage = (event) => {
    const pcmData = convertFloat32ToPCM(event.data);
    audioRecorderHandler(pcmData);
  };
  
  return [audioRecorderNode, audioRecorderContext, micStream] as const;
}

function convertFloat32ToPCM(inputData: Float32Array) {
  const pcm16 = new Int16Array(inputData.length);
  for (let i = 0; i < inputData.length; i++) {
    pcm16[i] = inputData[i] * 0x7fff;
  }
  return pcm16.buffer;
}

export default function Home() {
  const [userId] = useState<string>(() => Math.random().toString().substring(10));
  const [connected, setConnected] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [micEnabled, setMicEnabled] = useState(false);
  const [turnInProgress, setTurnInProgress] = useState(false);
  const [isAudio, setIsAudio] = useState(false);
  const [currentMessageId, setCurrentMessageId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioPlayerNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioPlayerContextRef = useRef<AudioContext | null>(null);
  const audioRecorderNodeRef = useRef<AudioWorkletNode | null>(null);
  const audioRecorderContextRef = useRef<AudioContext | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Audio buffering for 200ms intervals
  const audioBufferRef = useRef<Uint8Array[]>([]);
  const bufferTimerRef = useRef<NodeJS.Timeout | null>(null);
  const inFlightRef = useRef(false);

  const wsBaseUrl = useMemo(() => {
    const envUrl = (globalThis as any)?.process?.env?.NEXT_PUBLIC_BACKEND_HTTP_URL as string | undefined;
    try {
      const url = new URL(envUrl || 'http://localhost:8000');
      const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${wsProtocol}//${url.host}`; // keep backend host:port
    } catch {
      return 'ws://localhost:8000';
    }
  }, []);

  const appendMessage = useCallback((text: string) => {
    setMessages((m) => [...m, text]);
  }, []);

  // Play incoming PCM 16-bit mono at 24kHz (Gemini audio output)
  const playPcm = useCallback(async (arrayBuffer: ArrayBuffer) => {
    if (audioPlayerNodeRef.current) {
      audioPlayerNodeRef.current.port.postMessage(arrayBuffer);
    }
  }, []);

  // WebSocket connect
  const connect = useCallback(() => {
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) return;

    const url = `${wsBaseUrl}/ws/${userId}?is_audio=${isAudio}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connection opened.');
      setConnected(true);
      setMessages(prev => [...prev, 'Connection opened']);
    };

    ws.onclose = () => {
      console.log('WebSocket connection closed.');
      setConnected(false);
      setMessages(prev => [...prev, 'Connection closed']);
      setTimeout(() => {
        console.log('Reconnecting...');
        connect();
      }, 5000);
    };

    ws.onerror = (e) => {
      console.warn('WebSocket error', e);
    };

    ws.onmessage = (evt) => {
      try {
        const obj = JSON.parse(evt.data);
        console.log('[AGENT TO CLIENT]', obj);

        // Turn events
        if (obj.turn_complete !== undefined || obj.interrupted !== undefined) {
          if (obj.turn_complete || obj.interrupted) {
            setTurnInProgress(false);
            setCurrentMessageId(null);
          }
          if (obj.interrupted && audioPlayerNodeRef.current) {
            audioPlayerNodeRef.current.port.postMessage({ command: 'endOfAudio' });
          }
          return;
        }

        // Audio
        if (obj.mime_type && String(obj.mime_type).startsWith('audio/pcm')) {
          const buf = base64ToArrayBuffer(obj.data);
          playPcm(buf);
          setTurnInProgress(true);
          return;
        }

        // Text
        if (obj.mime_type === 'text/plain') {
          if (currentMessageId === null) {
            const newMessageId = Math.random().toString(36).substring(7);
            setCurrentMessageId(newMessageId);
            setMessages(prev => [...prev, obj.data]);
          } else {
            setMessages(prev => {
              const newMessages = [...prev];
              if (newMessages.length > 0) {
                newMessages[newMessages.length - 1] += obj.data;
              }
              return newMessages;
            });
          }
          setTurnInProgress(true);
          return;
        }
      } catch (err) {
        console.warn('Non-JSON WS message:', evt.data);
      }
    };
  }, [wsBaseUrl, userId, isAudio, playPcm, currentMessageId]);

  // Send text via POST
  const sendText = useCallback(async () => {
    const text = input.trim();
    if (!text || !connected) return;
    try {
      wsRef.current?.send(JSON.stringify({ mime_type: 'text/plain', data: text }));
      console.log('[CLIENT TO AGENT]:', text);
      setMessages(prev => [...prev, `> ${text}`]);
      setInput('');
    } catch (e) {
      console.error('Failed to send text', e);
    }
  }, [connected, input]);

  // Send buffered audio data every 200ms
  const sendBufferedAudio = useCallback(async () => {
    if (audioBufferRef.current.length === 0) {
      return;
    }
    
    // Calculate total length
    let totalLength = 0;
    for (const chunk of audioBufferRef.current) {
      totalLength += chunk.length;
    }
    
    // Combine all chunks into a single buffer
    const combinedBuffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of audioBufferRef.current) {
      combinedBuffer.set(chunk, offset);
      offset += chunk.length;
    }
    
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      wsRef.current?.send(JSON.stringify({
        mime_type: 'audio/pcm',
        data: arrayBufferToBase64(combinedBuffer.buffer),
      }));
      console.log('[CLIENT TO AGENT] sent %s bytes', combinedBuffer.byteLength);
    } catch (e) {
      console.warn('Audio chunk send failed', e);
    } finally {
      inFlightRef.current = false;
    }
    
    // Clear the buffer
    audioBufferRef.current = [];
  }, [userId]);

  // Audio recorder handler
  const audioRecorderHandler = useCallback((pcmData: ArrayBuffer) => {
    // Add audio data to buffer
    audioBufferRef.current.push(new Uint8Array(pcmData));
    
    // Start timer if not already running
    if (!bufferTimerRef.current) {
      bufferTimerRef.current = setInterval(sendBufferedAudio, 200); // 200ms intervals
    }
  }, [sendBufferedAudio]);

  // Start audio (both player and recorder)
  const startAudio = useCallback(async () => {
    try {
      // Start audio output
      const [playerNode, playerContext] = await startAudioPlayerWorklet();
      audioPlayerNodeRef.current = playerNode;
      audioPlayerContextRef.current = playerContext;
      
      // Start audio input
      const [recorderNode, recorderContext, stream] = await startAudioRecorderWorklet(audioRecorderHandler);
      audioRecorderNodeRef.current = recorderNode;
      audioRecorderContextRef.current = recorderContext;
      micStreamRef.current = stream;
      
      setMicEnabled(true);
      setIsAudio(true);

      // Reconnect WS with audio mode
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
        setConnected(false);
      }
      setTimeout(() => connect(), 100);
      
    } catch (error) {
      console.error('Failed to start audio:', error);
    }
  }, [audioRecorderHandler, connect]);

  const stopMic = useCallback(() => {
    try {
      // Stop buffering timer
      if (bufferTimerRef.current) {
        clearInterval(bufferTimerRef.current);
        bufferTimerRef.current = null;
      }
      
      // Send any remaining buffered audio
      if (audioBufferRef.current.length > 0) {
        sendBufferedAudio();
      }
      
      // Disconnect audio nodes
      audioRecorderNodeRef.current?.disconnect();
      audioRecorderNodeRef.current = null;
      audioRecorderContextRef.current?.close();
      audioRecorderContextRef.current = null;
      
      // Stop microphone stream
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      
      setMicEnabled(false);
      audioBufferRef.current = [];
      inFlightRef.current = false;
    } catch (error) {
      console.error('Error stopping microphone:', error);
    }
  }, [sendBufferedAudio]);

  useEffect(() => {
    // Auto-connect like static app
    connect();
    return () => {
      try { wsRef.current?.close(); } catch {}
      audioPlayerContextRef.current?.close();
      audioRecorderContextRef.current?.close();
      stopMic();
    };
  }, [connect, stopMic]);

  // Auto-connect on mount to mirror the static sample behavior
  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />
      
      <main className="container mx-auto max-w-5xl p-6 space-y-6 flex-1">
        {/* Connection Status Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>Connection Status</span>
              <Badge variant={connected ? 'default' : 'secondary'} className="text-sm" aria-live="polite">
                <div className="flex items-center gap-2">
                  {connected ? (
                    <>
                      <Radio className="h-3 w-3 animate-pulse" />
                      Connected
                    </>
                  ) : (
                    <>Disconnected</>
                  )}
                </div>
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Audio Control */}
            <div className="flex flex-wrap items-center gap-3">
              {!micEnabled ? (
                <Button 
                  onClick={startAudio} 
                  size="lg"
                  className="gap-2"
                  aria-label="Start Audio"
                >
                  <Mic className="h-5 w-5" />
                  Start Voice Mode
                </Button>
              ) : (
                <Button 
                  onClick={stopMic} 
                  size="lg"
                  variant="destructive"
                  className="gap-2"
                  aria-label="Stop Audio"
                >
                  <MicOff className="h-5 w-5" />
                  Stop Voice Mode
                </Button>
              )}

              {micEnabled && (
                <Badge variant="outline" className="text-sm gap-2 px-3 py-1">
                  <Mic className="h-3 w-3 text-green-500 animate-pulse" />
                  Microphone Active
                </Badge>
              )}
            </div>

            {/* Agent Status Indicator */}
            {connected && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Agent Status:</span>
                  <div className="flex items-center gap-2">
                    {turnInProgress ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-primary" />
                        <span className="font-medium text-primary">Speaking...</span>
                      </>
                    ) : (
                      <>
                        <div className="h-2 w-2 rounded-full bg-green-500" />
                        <span className="font-medium text-green-600 dark:text-green-400">Idle</span>
                      </>
                    )}
                  </div>
                </div>
                {turnInProgress && (
                  <Progress value={undefined} className="h-1" />
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Text Input Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Text Chat
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendText();
                }}
                placeholder="Type your message here..."
                className="text-base"
                disabled={!connected}
                aria-label="Chat message"
              />
              <Button 
                onClick={sendText} 
                disabled={!connected || !input.trim()} 
                size="icon"
                className="shrink-0"
                aria-label="Send message"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Messages Card */}
        <Card className="flex-1">
          <CardHeader>
            <CardTitle>Conversation</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-96 pr-4">
              <div className="space-y-3">
                {messages.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    <MessageSquare className="h-12 w-12 mx-auto mb-3 opacity-20" />
                    <p>No messages yet. Start a conversation!</p>
                  </div>
                ) : (
                  messages.map((m: string, i: number) => {
                    const isUser = m.startsWith('>');
                    const text = isUser ? m.substring(1).trim() : m;
                    
                    return (
                      <div 
                        key={i} 
                        className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
                      >
                        <div 
                          className={`rounded-lg px-4 py-2.5 max-w-[80%] ${
                            isUser 
                              ? 'bg-primary text-primary-foreground ml-auto' 
                              : m.includes('Connection') || m.includes('Reconnecting')
                              ? 'bg-muted text-muted-foreground text-xs italic'
                              : 'bg-muted'
                          }`}
                        >
                          <p className="text-sm leading-relaxed whitespace-pre-wrap break-words">
                            {text}
                          </p>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Separator />

        {/* Debug Info */}
        <div className="text-xs text-muted-foreground bg-muted/30 rounded-lg p-3 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">Backend WS:</span>
            <code className="bg-muted px-1.5 py-0.5 rounded">{wsBaseUrl}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">User ID:</span>
            <code className="bg-muted px-1.5 py-0.5 rounded">{userId}</code>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-medium">Audio Mode:</span>
            <code className="bg-muted px-1.5 py-0.5 rounded">{isAudio ? 'enabled' : 'disabled'}</code>
          </div>
        </div>
      </main>
    </div>
  );
}


