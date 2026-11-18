stream=true
if [ "$stream" = true ]; then
    accept_header='Accept: text/event-stream'
else
    accept_header='Accept: application/json'
fi

cat > payload.json <<JSON
{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What is in this image?"
        },
        {
          "type": "image_url",
          "image_url": {
            "url": "https://assets.ngc.nvidia.com/products/api-catalog/phi-3-5-vision/example1b.jpg"
          }
        }
      ]
    }
  ],
  "model": "moonshotai/kimi-k3.1-pro",
  "max_tokens": 16384,
  "seed": 0,
  "stream": true,
  "reasoning_effort": "low"
}
JSON

curl https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer KIMI_ENDPOINT_API_KEY" \
  -H "Content-Type: application/json" \
  -H "$accept_header" \
  -d @payload.json
