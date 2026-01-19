## Agent Studio

Agent Studio is a **local-first desktop app** for designing, running, and inspecting LLM agent workflows.

### Features

#### Visual Workflow Designer
Build agent workflows using a drag-and-drop graph editor. Connect nodes to define how data and control flow through your agents:

- **Input nodes**: Define the inputs your workflow accepts
- **Agent nodes**: Configure LLM-powered agents with custom instructions and tools
- **Tool nodes**: Add capabilities like code execution, web browsing, or custom integrations
- **Loop groups**: Create iterative patterns for multi-step reasoning
- **Output nodes**: Specify what your workflow returns

#### Version Control for Workflows
Save snapshots of your workflows as versioned revisions. Compare changes, roll back to previous versions, and maintain a history of your agent designs.

#### Local Run Execution
Run your workflows entirely on your local machine. Provide structured inputs, tag runs for organization, and execute against any saved revision.

#### Live Trace Viewer
Watch your agent workflows execute in real-time. The trace viewer streams events as they happen, showing you:

- Each step the agent takes
- Tool calls and their results
- LLM prompts and responses
- Timing and status information

You can also review completed runs by loading their persisted traces.

#### Privacy by Default
All workflows, runs, and trace data are stored locally on your machine. Nothing is sent to external servers beyond the LLM API calls you configure.

### Getting Started

1. **Configure your LLM connection**: Open Settings and provide your API credentials for your preferred LLM provider.

2. **Design a workflow**: Use the graph editor to create your first agent workflow by adding nodes and connecting them.

3. **Save a revision**: Save your workflow to create a versioned snapshot you can run.

4. **Start a run**: Launch your workflow with the inputs you want to test.

5. **Inspect the trace**: Watch the execution in real-time or review the trace after completion.

### Use Cases

- **Prototype agent architectures**: Quickly iterate on different agent designs without writing code
- **Debug agent behavior**: Use the trace viewer to understand exactly what your agents are doing
- **Test prompt variations**: Save different revisions to compare how changes affect agent performance
- **Build multi-agent systems**: Connect multiple agents together with tool nodes and loops
