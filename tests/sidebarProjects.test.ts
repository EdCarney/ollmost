import { describe, expect, it } from 'vitest'
import { SIDEBAR_PROJECT_COUNT, sidebarProjects } from '../src/shared/sidebarProjects'

const project = (id: string, updatedAt: number, pinned = false) => ({ id, updatedAt, pinned })
const ids = (list: Array<{ id: string }>) => list.map((p) => p.id)

describe('the projects the sidebar lists', () => {
  const many = Array.from({ length: 12 }, (_, i) => project(`p${i}`, i))

  it('lists the 8 most recently active, latest first', () => {
    expect(SIDEBAR_PROJECT_COUNT).toBe(8)
    expect(ids(sidebarProjects(many, [], null))).toEqual(['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4'])
  })

  it('puts pinned projects first, even ones not used lately', () => {
    const list = [...many.slice(1), project('old', 0, true)]
    expect(ids(sidebarProjects(list, [], null))).toEqual(['old', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5'])
  })

  it('lists at most 8 when more than 8 are pinned', () => {
    const pinned = many.map((p) => ({ ...p, pinned: true }))
    expect(sidebarProjects(pinned, [], null)).toHaveLength(8)
  })

  it('counts a chat’s activity as the project’s', () => {
    const list = sidebarProjects(
      many,
      [
        { projectId: 'p0', updatedAt: 100 },
        { projectId: null, updatedAt: 200 }
      ],
      null
    )
    expect(ids(list)[0]).toBe('p0')
    expect(ids(list)).not.toContain('p4')
  })

  it('keeps the project in view listed, after the others, when it isn’t among the 8', () => {
    expect(ids(sidebarProjects(many, [], 'p1'))).toEqual(['p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p5', 'p4', 'p1'])
  })

  it('lists the project in view once when it is among the 8', () => {
    expect(ids(sidebarProjects(many, [], 'p11'))).toHaveLength(8)
  })

  it('ignores a project in view that no longer exists', () => {
    expect(ids(sidebarProjects(many, [], 'gone'))).toHaveLength(8)
  })
})
