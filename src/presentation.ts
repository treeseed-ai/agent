import { type AgentExecutionResult } from '@treeseed-cordis/sdk';
import { type UiViewModel } from '@treeseed-cordis/ui/contracts';
import { type AgentStatus } from './application.js';
export class AgentViewModel {
  static result(result: AgentExecutionResult): UiViewModel {
    return {
      id: 'agent-execution',
      componentId: 'status',
      model: {
        title: 'Agent composition probe',
        state: result.state,
        detail: result.output ?? result.blockers[0]?.message ?? 'No output.',
      },
    };
  }
  static status(status: AgentStatus): UiViewModel {
    return {
      id: 'agent-status',
      componentId: 'status',
      model: {
        title: 'Agent composition',
        state: status.ready ? 'Ready' : 'Not ready',
        detail: 'Provider ' + status.providerId + '; generation ' + status.generation,
      },
    };
  }
  static async render(value: AgentExecutionResult | AgentStatus): Promise<string> {
    const { UiTerminalRenderer } = await import('@treeseed-cordis/ui/terminal'),
      renderer = await UiTerminalRenderer.create();
    try {
      return (await renderer.render('state' in value ? this.result(value) : this.status(value)))
        .text;
    } finally {
      await renderer.dispose();
    }
  }
}
