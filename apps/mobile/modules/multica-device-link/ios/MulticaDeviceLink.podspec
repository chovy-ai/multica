Pod::Spec.new do |s|
  s.name = 'MulticaDeviceLink'
  s.version = '0.1.0'
  s.summary = 'Multica iOS device connection client'
  s.description = 'Reuses the account device-link protocol without running agents on iOS.'
  s.license = { :type => 'Multica License' }
  s.author = 'Multica'
  s.homepage = 'https://github.com/multica-ai/multica'
  s.source = { :git => 'https://github.com/multica-ai/multica.git' }
  s.platform = :ios, '16.4'
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.vendored_frameworks = 'MulticaLink.xcframework'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
