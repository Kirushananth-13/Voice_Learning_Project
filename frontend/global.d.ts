declare module '/js/audio-player.js' {
  export function startAudioPlayerWorklet(): Promise<[any, AudioContext]>;
}

declare module '/js/audio-recorder.js' {
  export function startAudioRecorderWorklet(callback: (pcmData: ArrayBuffer) => void): Promise<[any, AudioContext, MediaStream]>;
  export function stopMicrophone(stream: MediaStream): void;
}
