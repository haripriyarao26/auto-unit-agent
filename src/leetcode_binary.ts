export function searchInsert(nums: number[], target: number): number {
    let left = 0;
    let right = nums.length - 1;
  
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      // Even if we find it, keep looking left to find the FIRST occurrence
      if (nums[mid] >= target) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    return left;
  }