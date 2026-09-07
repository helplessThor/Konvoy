/**
 * KonvoyBackgroundManager.swift — iOS Background Execution
 *
 * Configures and manages background mode entitlements for
 * CoreBluetooth state restoration, background location updates,
 * and VoIP push registration.
 *
 * Required UIBackgroundModes in Info.plist:
 *   - bluetooth-central
 *   - bluetooth-peripheral
 *   - location
 *   - voip (for wake-from-suspend)
 */

import Foundation
import CoreLocation
import PushKit
import UIKit

@objc(KonvoyBackgroundManager)
class KonvoyBackgroundManager: NSObject {

    static let shared = KonvoyBackgroundManager()

    // MARK: - Location

    private lazy var locationManager: CLLocationManager = {
        let manager = CLLocationManager()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
        manager.showsBackgroundLocationIndicator = true
        manager.distanceFilter = 5.0 // Update every 5 meters
        return manager
    }()

    // MARK: - VoIP Push

    private var voipRegistry: PKPushRegistry?
    private var onLocationUpdate: ((_ latitude: Double, _ longitude: Double, _ heading: Double, _ speed: Double, _ altitude: Double, _ accuracy: Double) -> Void)?

    // MARK: - Start

    @objc
    func startBackgroundServices(
        onLocationUpdate: @escaping (_ latitude: Double, _ longitude: Double, _ heading: Double, _ speed: Double, _ altitude: Double, _ accuracy: Double) -> Void
    ) {
        self.onLocationUpdate = onLocationUpdate

        // Request location permission
        let status = locationManager.authorizationStatus
        if status == .notDetermined {
            locationManager.requestAlwaysAuthorization()
        } else if status == .authorizedAlways || status == .authorizedWhenInUse {
            startLocationUpdates()
        }

        // Register for VoIP push (keeps the app alive for incoming calls)
        registerVoIPPush()
    }

    @objc
    func stopBackgroundServices() {
        locationManager.stopUpdatingLocation()
        locationManager.stopMonitoringSignificantLocationChanges()
        onLocationUpdate = nil
    }

    // MARK: - Location Updates

    private func startLocationUpdates() {
        locationManager.startUpdatingLocation()
        locationManager.startUpdatingHeading()

        // Also register for significant location changes as a fallback
        // This ensures we get woken up even if the OS kills continuous updates
        locationManager.startMonitoringSignificantLocationChanges()
    }

    // MARK: - VoIP Push

    private func registerVoIPPush() {
        voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
        voipRegistry?.delegate = self
        voipRegistry?.desiredPushTypes = [.voIP]
    }

    // MARK: - Info.plist Configuration Check

    @objc
    static func verifyBackgroundModes() -> [String: Bool] {
        let requiredModes = [
            "bluetooth-central",
            "bluetooth-peripheral",
            "location",
            "voip"
        ]

        guard let bgModes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] else {
            return requiredModes.reduce(into: [:]) { $0[$1] = false }
        }

        return requiredModes.reduce(into: [:]) { result, mode in
            result[mode] = bgModes.contains(mode)
        }
    }
}

// MARK: - CLLocationManagerDelegate

extension KonvoyBackgroundManager: CLLocationManagerDelegate {

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }

        onLocationUpdate?(
            location.coordinate.latitude,
            location.coordinate.longitude,
            location.course >= 0 ? location.course : 0,
            max(location.speed * 3.6, 0), // m/s to km/h, clamp negative
            location.altitude,
            location.horizontalAccuracy
        )
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            startLocationUpdates()
        default:
            break
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        NSLog("[KonvoyBackground] Location error: \(error.localizedDescription)")
    }
}

// MARK: - PKPushRegistryDelegate

extension KonvoyBackgroundManager: PKPushRegistryDelegate {

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        // VoIP push token received — not used for actual push delivery
        // but registration keeps background execution alive
        let token = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        NSLog("[KonvoyBackground] VoIP push token: \(token)")
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        // Handle incoming VoIP push (e.g., from Nostr relay bridge)
        NSLog("[KonvoyBackground] Received VoIP push")
        completion()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        NSLog("[KonvoyBackground] VoIP push token invalidated")
    }
}
