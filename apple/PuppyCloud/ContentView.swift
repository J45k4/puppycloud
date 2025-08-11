 //
//  ContentView.swift
//  PuppyCloud
//
//  Created by puppy on 7.8.2025.
//

import SwiftUI
import AVFoundation

struct ContentView: View {
    @State private var selectedTab: Int = 0
    @State private var showScanner: Bool = false
    @State private var scannedText: String? = nil

    var body: some View {
        ZStack {
            TabView(selection: $selectedTab) {
                ConnectView(
                    scannedText: scannedText,
                    onScannedTextConsumed: { scannedText = nil },
                    onScanQr: { showScanner = true }
                )
                .tabItem { Label("Connect", systemImage: "link") }
                .tag(0)

                PeersView()
                    .tabItem { Label("Peers", systemImage: "person.2") }
                    .tag(1)

                GalleryView()
                    .tabItem { Label("Gallery", systemImage: "photo.on.rectangle.angled") }
                    .tag(2)
            }

            if showScanner {
                QRScannerView(
                    onResult: { value in
                        showScanner = false
                        scannedText = value
                    },
                    onCancel: { showScanner = false }
                )
                .transition(.opacity)
                .zIndex(1)
            }
        }
    }
}

#Preview {
    ContentView()
}
