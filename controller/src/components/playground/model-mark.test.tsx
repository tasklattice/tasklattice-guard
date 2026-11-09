import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelMark } from './model-mark';

afterEach(cleanup);
describe('Playground Provider logo', () => {
  it.each([
    ['NVIDIA NIM', 'nvidia nim', 'nvidia.webp'],
    ['OpenAI', 'openai', 'openai.webp'],
    ['DeepSeek', 'deepseek', 'deepseek.webp'],
    ['Qwen', 'qwen', 'qwen.webp'],
    ['Ollama', 'ollama', 'ollama.webp'],
    ['vLLM', 'vllm', 'vllm.webp'],
    ['Internal Gateway', 'custom-openai-compatible', 'custom.svg'],
    ['Renamed Provider', 'nvidia-nim', 'nvidia.webp'],
  ])('renders %s from the Provider identity', (provider, icon, asset) => {
    const { container } = render(<ModelMark model={{ provider, icon }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/assets/providers/${asset}`);
  });
  it('uses a neutral fallback when no Provider is available', () => {
    const { container } = render(<ModelMark />);
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
