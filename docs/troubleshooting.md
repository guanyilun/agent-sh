# Troubleshooting

## Internal Agent Issues

**Problem**: No response from agent (thinking appears but no text)

**Solutions**:
1. Check API key: `echo $OPENAI_API_KEY`
2. Test the API endpoint directly:
   ```bash
   curl -s "$OPENAI_BASE_URL/models" -H "Authorization: Bearer $OPENAI_API_KEY" | head
   ```
3. Verify the model name is correct for your provider

**Problem**: "context overflow" or response cut off

**Solution**: The conversation is too long. Use `/clear` to start fresh, or the agent will auto-compact after the error.

**Problem**: Tool calls not working (agent responds but doesn't use tools)

**Solution**: Some models have limited or no tool/function calling support. Try a more capable model (e.g., gpt-4o, claude-sonnet-4-6 via OpenRouter).

## ACP Agent Issues

**Problem**: "Agent not connected. Please wait a moment and try again."

**Solutions**:
1. Check agent installation:
   ```bash
   which pi-acp
   which claude-agent-acp
   ```
2. Install missing agents:
   ```bash
   npm install -g pi-acp
   npm install -g @agentclientprotocol/claude-agent-acp
   ```
3. Check API keys:
   ```bash
   echo $ANTHROPIC_API_KEY
   echo $OPENAI_API_KEY
   ```

**Problem**: "Agent process exited with code X"
- Check agent installation and API key validity
- Try running the agent directly to see its error output

## Common Errors

**Error**: "API key not found" or "401 Unauthorized"
- **Cause**: Missing or invalid API key
- **Solution**: Set the appropriate key: `export OPENAI_API_KEY="your-key"`

**Error**: "Invalid model name" or "404 Not Found"
- **Cause**: Model not available at the configured endpoint
- **Solution**: Check available models for your provider. Local providers (Ollama, LM Studio) need the model downloaded first.

**Error**: Stream errors or disconnections
- **Cause**: Network issues or provider rate limits
- **Solution**: The agent will show the error. Try again, or check provider status.

## Debug Mode

Enable debug mode for detailed protocol logging:

```bash
# Internal agent
DEBUG=1 agent-sh --api-key "$KEY" --model gpt-4o

# ACP agent
DEBUG=1 agent-sh --agent pi-acp
```

## Getting Help

If you encounter issues:
1. Check the [Usage Guide](usage.md) for provider configuration
2. Try a different model or provider to isolate the problem
3. Check [GitHub issues](https://github.com/guanyilun/agent-sh/issues) for known problems
