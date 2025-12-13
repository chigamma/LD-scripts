# Changelog

## [1.1.0] - 2025-12-14

### Added
- **Real-time badge updates**: Badges now update immediately when you follow/unfollow users without page refresh
- Network hook for Fetch and XMLHttpRequest to detect follow/unfollow actions

### Changed
- Refactored code structure with shared state management

## [1.0.1] - 2025-12-13

### Fixed
- Mobile layout compatibility - badges now display correctly on mobile devices

### Changed
- Enhanced selector logic to support both desktop and mobile DOM structures

## [1.0.0] - 2025-12-13

### Added
- Initial release with core functionality
- Three relationship badge types: Mutual (互关), Following (关注), Follower (粉丝)
- MutationObserver for dynamic content loading
- Manual cache clearing via Tampermonkey menu

### Features
- Badges display next to usernames in topic posts
- Compatible with linux.do forum
- Minimal performance impact. Runs only on topic pages
