/**
 * Text embeddings via Amazon Titan Text Embeddings v2 (AWS Bedrock).
 * Used for the semantic plan cache (different wordings of the same task map to
 * nearby vectors, so a paraphrase still hits the cache).
 */
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const EMBED_MODEL_ID = process.env.BEDROCK_EMBED_MODEL_ID || 'amazon.titan-embed-text-v1';

/** Returns a 1536-dim embedding for `text` (Titan v1 is fixed at 1536). */
async function embedText(text) {
  const command = new InvokeModelCommand({
    modelId: EMBED_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ inputText: String(text).slice(0, 8000) }),
  });
  const response = await client.send(command);
  const parsed = JSON.parse(Buffer.from(response.body).toString());
  return parsed.embedding; // float[1536]
}

module.exports = { embedText };
