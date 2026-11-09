import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AiProviderForm, EMPTY_PROVIDER_FORM, PROVIDER_PRESETS } from './AiProviderSettings'

const noop = (): void => {}

describe('AiProviderForm', () => {
  it('labels every field and splits cloud from local presets', () => {
    render(
      <AiProviderForm
        providers={[]}
        configForm={EMPTY_PROVIDER_FORM}
        onFormChange={noop}
        onSave={noop}
        onRemove={noop}
        onApplyPreset={noop}
      />,
    )
    expect(screen.getByText('快速填充')).toBeTruthy()
    expect(screen.getByRole('button', { name: '快速填充服务商' })).toBeTruthy()
    expect(PROVIDER_PRESETS.length).toBeGreaterThanOrEqual(16)
    expect(screen.getByText('连接信息')).toBeTruthy()
    expect(screen.getByText('模型')).toBeTruthy()
    // 每个字段都有可见 label,不再只靠 placeholder 说明自己是什么。
    for (const label of [/名称/, /Base URL/, /API Key/, /对话模型/, /Embedding/, /TTS/]) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('alert')).toBeNull()
    // 连接 / 模型并排,才不至于在 78dvh 弹窗里滚半天。
    expect(document.querySelector('.ai-fields-grid')).toBeTruthy()
    expect(document.querySelectorAll('.ai-fields-grid .ai-section')).toHaveLength(2)
  })
})
