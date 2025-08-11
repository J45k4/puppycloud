package puppycorp.puppycloud.ui

import android.Manifest
import android.content.ContentUris
import android.net.Uri
import android.provider.MediaStore
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import coil.compose.AsyncImage
import coil.request.ImageRequest
import androidx.compose.ui.viewinterop.AndroidView

// Simple item representing a piece of media in the device gallery
sealed class MediaItem(open val id: Long, open val uri: Uri) {
    data class Photo(override val id: Long, override val uri: Uri): MediaItem(id, uri)
    data class Video(override val id: Long, override val uri: Uri, val durationMs: Long): MediaItem(id, uri)
}

@Composable
fun GalleryScreen(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(0.dp),
) {
    val context = LocalContext.current

    // Runtime permissions (scoped storage - READ_MEDIA_IMAGES/VIDEO from API 33+, READ_EXTERNAL_STORAGE older)
    val permissionState = remember { mutableStateOf(false) }
    val permissionLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        contract = androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions(),
        onResult = { results ->
            permissionState.value = results.values.any { it }
        }
    )

    LaunchedEffect(Unit) {
        val perms = if (android.os.Build.VERSION.SDK_INT >= 33) {
            arrayOf(
                Manifest.permission.READ_MEDIA_IMAGES,
                Manifest.permission.READ_MEDIA_VIDEO
            )
        } else {
            arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
        }
        permissionLauncher.launch(perms)
    }

    var loading by remember { mutableStateOf(true) }
    val items = remember { mutableStateListOf<MediaItem>() }
    var selected by rememberSaveable { mutableStateOf<MediaItem?>(null) }

    LaunchedEffect(permissionState.value) {
        if (!permissionState.value) return@LaunchedEffect
        loading = true
        items.clear()
        // Query media store for images and videos, newest first
        val imageCollection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val videoCollection = MediaStore.Video.Media.EXTERNAL_CONTENT_URI

        val imageProjection = arrayOf(
            MediaStore.Images.Media._ID
        )

        val videoProjection = arrayOf(
            MediaStore.Video.Media._ID,
            MediaStore.Video.Media.DURATION
        )

        val sortOrder = MediaStore.Images.Media.DATE_ADDED + " DESC"

        context.contentResolver.query(imageCollection, imageProjection, null, null, sortOrder)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idIndex)
                val contentUri = ContentUris.withAppendedId(imageCollection, id)
                items.add(MediaItem.Photo(id, contentUri))
            }
        }

        context.contentResolver.query(videoCollection, videoProjection, null, null, sortOrder)?.use { cursor ->
            val idIndex = cursor.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
            val durationIndex = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION)
            while (cursor.moveToNext()) {
                val id = cursor.getLong(idIndex)
                val duration = cursor.getLong(durationIndex)
                val contentUri = ContentUris.withAppendedId(videoCollection, id)
                items.add(MediaItem.Video(id, contentUri, duration))
            }
        }
        // Optionally sort combined list by date desc if we had date for both; for simplicity keep as appended
        loading = false
    }

    Box(
        modifier = modifier
            .fillMaxSize()
            .padding(contentPadding)
            .padding(horizontal = 8.dp, vertical = 8.dp)
    ) {
        if (!permissionState.value) {
            Text(
                text = "Storage permission required to show gallery.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.Center)
            )
        } else if (loading) {
            CircularProgressIndicator(modifier = Modifier.align(Alignment.Center))
        } else {
            MediaGrid(items = items, onClick = { selected = it })
        }

        if (selected != null) {
            FullscreenViewer(item = selected!!, onDismiss = { selected = null })
        }
    }
}

@Composable
private fun MediaGrid(items: List<MediaItem>, onClick: (MediaItem) -> Unit) {
    LazyVerticalGrid(
        columns = GridCells.Adaptive(minSize = 120.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        contentPadding = PaddingValues(4.dp)
    ) {
        items(items, key = { it.id to it.uri.toString() }) { item ->
            MediaGridItem(item = item, onClick = onClick)
        }
    }
}

@Composable
private fun MediaGridItem(item: MediaItem, onClick: (MediaItem) -> Unit) {
    Box(
        modifier = Modifier
            .background(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.shapes.small)
            .clickable { onClick(item) }
    ) {
        AsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(item.uri)
                .crossfade(true)
                .build(),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.fillMaxSize()
        )
        if (item is MediaItem.Video) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.2f))
            )
            Text(
                text = "▶",
                style = MaterialTheme.typography.headlineMedium,
                color = Color.White,
                modifier = Modifier.align(Alignment.Center)
            )
        }
    }
}

@Composable
private fun FullscreenViewer(item: MediaItem, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
            when (item) {
                is MediaItem.Photo -> AsyncImage(
                    model = item.uri,
                    contentDescription = null,
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize()
                )
                is MediaItem.Video -> VideoPlayer(uri = item.uri)
            }
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)) {
                Text("Close", color = Color.White)
            }
        }
    }
}

@Composable
private fun VideoPlayer(uri: Uri) {
    val context = LocalContext.current
    // Using Media3 ExoPlayer for playback
    val exoPlayer = remember(uri) {
        androidx.media3.exoplayer.ExoPlayer.Builder(context).build().apply {
            val mediaItem = androidx.media3.common.MediaItem.fromUri(uri)
            setMediaItem(mediaItem)
            prepare()
            playWhenReady = true
        }
    }
    androidx.compose.runtime.DisposableEffect(exoPlayer) {
        onDispose { exoPlayer.release() }
    }
    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
            androidx.media3.ui.PlayerView(ctx).apply {
                useController = true
                player = exoPlayer
            }
        }
    )
}
