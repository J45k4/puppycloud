package puppycorp.puppycloud

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import puppycorp.puppycloud.ui.ConnectScreen
import puppycorp.puppycloud.ui.PeersScreen
import puppycorp.puppycloud.ui.Peer
import puppycorp.puppycloud.ui.theme.PuppyCloudTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            PuppyCloudTheme {
                val snackbarHostState = remember { SnackbarHostState() }
                var showScanner by rememberSaveable { androidx.compose.runtime.mutableStateOf(false) }
                var scannedText by rememberSaveable { androidx.compose.runtime.mutableStateOf<String?>(null) }
                var tabIndex by rememberSaveable { androidx.compose.runtime.mutableStateOf(0) }
                val tabs = listOf("Connect", "Peers")

                Scaffold(
                    modifier = Modifier.fillMaxSize(),
                    snackbarHost = { SnackbarHost(hostState = snackbarHostState) },
                    bottomBar = {
                        if (!showScanner) {
                            TabRow(selectedTabIndex = tabIndex) {
                                tabs.forEachIndexed { index, title ->
                                    Tab(
                                        selected = tabIndex == index,
                                        onClick = { tabIndex = index },
                                        text = { Text(title) }
                                    )
                                }
                            }
                        }
                    }
                ) { innerPadding ->
                    if (showScanner) {
                        puppycorp.puppycloud.ui.ScanQrScreen(
                            modifier = Modifier,
                            onResult = { value ->
                                showScanner = false
                                scannedText = value
                            },
                            onCancel = {
                                showScanner = false
                            }
                        )
                    } else {
                        when (tabIndex) {
                            0 -> ConnectScreen(
                                modifier = Modifier,
                                contentPadding = innerPadding,
                                snackbarHostState = snackbarHostState,
                                onConnect = { serverUrl, apiToken ->
                                    Log.i("PuppyCloud", "Connect requested: url=$serverUrl token=${apiToken.isNotEmpty()} ")
                                    // TODO: Wire to actual networking / Rust layer
                                },
                                onScanQr = {
                                    Log.i("PuppyCloud", "Scan QR requested")
                                    showScanner = true
                                },
                                scannedText = scannedText,
                                onScannedTextConsumed = {
                                    scannedText = null
                                }
                            )
                            1 -> {
                                // Placeholder peers; replace with real data later
                                val peers = listOf(
                                    Peer(id = "1", name = "Laptop", endpoint = "10.0.0.5:8443", status = "Online"),
                                    Peer(id = "2", name = "Home Server", endpoint = "example.local:8443", status = "Offline"),
                                )
                                PeersScreen(
                                    peers = peers,
                                    modifier = Modifier,
                                    contentPadding = innerPadding,
                                    onRefresh = {
                                        Log.i("PuppyCloud", "Peers refresh requested")
                                    },
                                    onPeerClick = { peer ->
                                        Log.i("PuppyCloud", "Peer clicked: ${peer.name}")
                                    }
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}
