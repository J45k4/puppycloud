package puppycorp.puppycloud.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import java.net.URI
import kotlinx.coroutines.launch

// Top-level helper so it can be referenced anywhere in this file
fun isValidUrl(text: String): Boolean = try {
    val uri = URI(text)
    uri.scheme != null && uri.host != null
} catch (_: Exception) { false }

@Composable
fun ConnectScreen(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
    snackbarHostState: SnackbarHostState? = null,
    onConnect: (serverUrl: String, apiToken: String) -> Unit = { _, _ -> },
    onScanQr: () -> Unit = {},
    scannedText: String? = null,
    onScannedTextConsumed: () -> Unit = {},
) {
    val focusManager = LocalFocusManager.current
    val scope = rememberCoroutineScope()

    var serverUrl by rememberSaveable { mutableStateOf("") }
    var apiToken by rememberSaveable { mutableStateOf("") }
    var connecting by remember { mutableStateOf(false) }
    var showToken by rememberSaveable { mutableStateOf(false) }
    var scanQr by rememberSaveable { mutableStateOf(false) }

    LaunchedEffect(scannedText) {
        val text = scannedText
        if (!text.isNullOrBlank()) {
            // Try direct URL
            if (isValidUrl(text)) {
                serverUrl = text
                onScannedTextConsumed()
                return@LaunchedEffect
            }
            // Try query string in a URI containing url/token params
            try {
                val uri = URI(text)
                val params = uri.rawQuery?.split('&')?.mapNotNull {
                    val parts = it.split('=')
                    if (parts.size == 2) parts[0] to java.net.URLDecoder.decode(parts[1], "UTF-8") else null
                }?.toMap().orEmpty()
                val urlParam = params["url"]
                val tokenParam = params["token"]
                if (urlParam != null && isValidUrl(urlParam)) {
                    serverUrl = urlParam
                }
                if (!tokenParam.isNullOrBlank()) {
                    apiToken = tokenParam
                }
                if (!urlParam.isNullOrBlank() || !tokenParam.isNullOrBlank()) {
                    onScannedTextConsumed()
                }
            } catch (_: Exception) {
                // ignore unrecognized format
            }
        }
    }

    Column(
        modifier = modifier
            .padding(contentPadding)
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = "Connect to Server", style = MaterialTheme.typography.headlineSmall)

        androidx.compose.foundation.layout.Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Scan QR from another peer")
            androidx.compose.material3.Switch(checked = scanQr, onCheckedChange = { scanQr = it })
        }

        if (!scanQr) {
            OutlinedTextField(
                value = serverUrl,
                onValueChange = { serverUrl = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Server URL") },
                placeholder = { Text("https://example.local:8443") },
                singleLine = true,
                isError = serverUrl.isNotEmpty() && !isValidUrl(serverUrl),
                supportingText = {
                    if (serverUrl.isNotEmpty() && !isValidUrl(serverUrl)) {
                        Text("Enter a valid URL with scheme, e.g. https://host:port")
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next)
            )

            OutlinedTextField(
                value = apiToken,
                onValueChange = { apiToken = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("API Token (optional)") },
                singleLine = true,
                visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = {
                    TextButton(onClick = { showToken = !showToken }) {
                        Text(if (showToken) "Hide" else "Show")
                    }
                },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = { focusManager.clearFocus() })
            )

            Button(
                enabled = !connecting && isValidUrl(serverUrl),
                onClick = {
                    if (!isValidUrl(serverUrl)) {
                        // Should not happen due to enabled state, but double-check
                        scope.launch {
                            snackbarHostState?.showSnackbar("Please enter a valid server URL")
                        }
                        return@Button
                    }
                    connecting = true
                    onConnect(serverUrl.trim(), apiToken.trim())
                    // For now we just show feedback and reset. Real wiring will handle lifecycle.
                    scope.launch {
                        snackbarHostState?.showSnackbar("Connecting to server…")
                        connecting = false
                    }
                }
            ) {
                if (connecting) {
                    CircularProgressIndicator(modifier = Modifier.padding(end = 12.dp))
                }
                Text("Connect")
            }

            Text(
                text = "Your server URL is never shared. Token is optional.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else {
            Button(onClick = { onScanQr() }, modifier = Modifier.fillMaxWidth()) {
                Text("Scan QR Code")
            }
            Text(
                text = "Scan a QR code exported from another device to import server settings.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
