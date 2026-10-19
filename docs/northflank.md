# Set up EconStats on Northflank

This gets your server online. **Connecting it to ChatGPT needs a separate sign-in
setup afterwards.** You can leave that until the server has its web address.

## 1. Create your account

Open [Northflank](https://app.northflank.com/) and choose **Developer Sandbox**
on **Northflank's managed cloud**. A payment method is required. Choose the free
resources and check that the estimate says **$0**. Skip extra storage and databases.

## 2. Connect your GitHub repository

Create a project, then choose a **combined build and deployment service**.
Connect GitHub and select **incanberra/econstats-mcp**.

Enter these settings; leave the other settings at their defaults:

| Setting | Enter |
| --- | --- |
| Branch | `codex/northflank-deployment` |
| Build method | Dockerfile |
| Dockerfile location | `/Dockerfile` |
| Build context | `/` |
| Number of instances | `1` |
| Port | `3000`, HTTP, public |
| Health check | HTTP, port `3000`, path `/health` |

Use the branch above while [PR #11](https://github.com/incanberra/econstats-mcp/pull/11)
is awaiting merge. Once it is merged, you can use `main`.

## 3. Add a private access password

In **runtime variables**, add these two entries:

| Name | Value |
| --- | --- |
| `MCP_AUTH_MODE` | `bearer` |
| `MCP_AUTH_TOKEN` | A new random password of at least 32 characters, without spaces |

Generate the password in your password manager and store it privately. Treat
`MCP_AUTH_TOKEN` as a secret. Keep the password out of GitHub and chat messages.

You can start without data-provider keys. To enable FRED, BEA or EIA, add your
existing keys privately under `FRED_API_KEY`, `BEA_API_KEY` or `EIA_API_KEY`.
You can add these later.

## 4. Create the service and check it

Click **Create service** and wait for it to become healthy. Copy the HTTPS
address Northflank gives you.

Add `/health` to that address and open it in your browser. It should show **ok**.
That confirms the server is running. The plain address without `/health` can
show “Not found”; that is expected.

## 5. Connect your app

Your MCP address is the assigned HTTPS address followed by **`/mcp`**.

- **Apps that accept an access token:** use the password from step 3 as the bearer
  token in the app's private connection settings.
- **ChatGPT:** the password above protects the server, but does not provide
  ChatGPT sign-in. The next task is to configure that sign-in using your new
  server address. You do not need to work through the technical reference just
  to finish these hosting steps.

The starting setup does not save revision history across restarts. Adding durable
storage can be a later decision.

[Technical reference](northflank-reference.md) ·
[Northflank's setup instructions](https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code)
