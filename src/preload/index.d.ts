import type { CourseHubApi } from './index'

declare global {
  interface Window {
    coursehub: CourseHubApi
  }
}

export {}
